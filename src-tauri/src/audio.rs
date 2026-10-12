use crate::engine::AudioMsg;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
use ringbuf::traits::{Producer, Split};
use ringbuf::{HeapProd, HeapRb};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
  pub device: String,
  pub sample_rate: u32,
  pub channels: u16,
}

pub struct AudioHandle {
  stop: Arc<AtomicBool>,
  thread: Option<JoinHandle<()>>,
  pub info: AudioInfo,
  pub device: Option<String>,
  pub channel: u16,
}

impl Drop for AudioHandle {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::Relaxed);
    if let Some(t) = self.thread.take() {
      let _ = t.join();
    }
  }
}

fn device_name(d: &cpal::Device) -> String {
  d.description()
    .map(|desc| desc.name().to_string())
    .unwrap_or_else(|_| d.to_string())
}

pub fn list_inputs() -> Result<Vec<String>, String> {
  let host = cpal::default_host();
  let devices = host.input_devices().map_err(|e| e.to_string())?;
  Ok(devices.map(|d| device_name(&d)).collect())
}

// cpal streams are not always Send, so each stream lives on its own thread
pub fn start(
  device: Option<String>,
  channel: u16,
  tx: Sender<AudioMsg>,
) -> Result<AudioHandle, String> {
  let stop = Arc::new(AtomicBool::new(false));
  let (ready_tx, ready_rx) = mpsc::channel();
  let stop_flag = stop.clone();
  let dev = device.clone();
  let thread = thread::spawn(move || match build(dev, channel, &tx) {
    Ok((stream, info)) => {
      let _ = ready_tx.send(Ok(info));
      while !stop_flag.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(50));
      }
      drop(stream);
      let _ = tx.send(AudioMsg::Stop);
    }
    Err(e) => {
      let _ = ready_tx.send(Err(e));
    }
  });
  let info = ready_rx
    .recv()
    .map_err(|_| "Audio thread died".to_string())??;
  Ok(AudioHandle {
    stop,
    thread: Some(thread),
    info,
    device,
    channel,
  })
}

fn build(
  name: Option<String>,
  channel: u16,
  tx: &Sender<AudioMsg>,
) -> Result<(cpal::Stream, AudioInfo), String> {
  let host = cpal::default_host();
  let device = match name.as_deref().filter(|n| !n.is_empty()) {
    Some(n) => host
      .input_devices()
      .map_err(|e| e.to_string())?
      .find(|d| device_name(d) == n)
      .ok_or(format!("Input device not found: {n}"))?,
    None => host
      .default_input_device()
      .ok_or("No default input device")?,
  };
  let supported = device.default_input_config().map_err(|e| e.to_string())?;
  let sample_rate = supported.sample_rate();
  let channels = supported.channels();
  let config: StreamConfig = supported.config();
  let (prod, cons) = HeapRb::<f32>::new(sample_rate as usize).split();
  let ch = if channel > channels { 0 } else { channel };

  let stream = match supported.sample_format() {
    SampleFormat::F32 => build_stream::<f32>(&device, config, channels, ch, prod),
    SampleFormat::I16 => build_stream::<i16>(&device, config, channels, ch, prod),
    SampleFormat::U16 => build_stream::<u16>(&device, config, channels, ch, prod),
    SampleFormat::I32 => build_stream::<i32>(&device, config, channels, ch, prod),
    SampleFormat::I8 => build_stream::<i8>(&device, config, channels, ch, prod),
    SampleFormat::U8 => build_stream::<u8>(&device, config, channels, ch, prod),
    SampleFormat::F64 => build_stream::<f64>(&device, config, channels, ch, prod),
    f => Err(format!("Unsupported sample format: {f:?}")),
  }?;
  stream.play().map_err(|e| e.to_string())?;
  let _ = tx.send(AudioMsg::Stream { cons, sample_rate });
  Ok((
    stream,
    AudioInfo {
      device: device_name(&device),
      sample_rate,
      channels,
    },
  ))
}

fn build_stream<T>(
  device: &cpal::Device,
  config: StreamConfig,
  channels: u16,
  channel: u16,
  mut prod: HeapProd<f32>,
) -> Result<cpal::Stream, String>
where
  T: SizedSample,
  f32: FromSample<T>,
{
  let channels = channels.max(1) as usize;
  let mut mono: Vec<f32> = Vec::with_capacity(4096);
  device
    .build_input_stream(
      config,
      move |data: &[T], _| {
        mono.clear();
        for frame in data.chunks_exact(channels) {
          let s = if channel > 0 {
            frame[channel as usize - 1].to_sample::<f32>()
          } else {
            frame.iter().map(|x| x.to_sample::<f32>()).sum::<f32>() / channels as f32
          };
          mono.push(s);
        }
        prod.push_slice(&mono);
      },
      |e| {
        // occasional xruns are expected and harmless for analysis
        if e.kind() != cpal::ErrorKind::Xrun {
          eprintln!("audio stream error: {e}")
        }
      },
      None,
    )
    .map_err(|e| e.to_string())
}
