use crate::config::{Mapping, OscMode, OutputKind};
use crate::output::Outputs;
use crate::Shared;
use ringbuf::traits::Consumer;
use ringbuf::HeapCons;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// spectrum sent to the UI: log-spaced points between these frequencies
pub const DISPLAY_POINTS: usize = 480;
pub const DISPLAY_MIN_HZ: f32 = 20.0;
pub const DISPLAY_MAX_HZ: f32 = 20000.0;
const FLOOR_DB: f32 = -120.0;
const HISTORY: usize = 16384;
const HOP: Duration = Duration::from_millis(5);
const FRAME_INTERVAL: Duration = Duration::from_millis(25);
// equivalent noise bandwidth of a Hann window, in bins
const HANN_ENBW: f32 = 1.5;

pub enum AudioMsg {
  Stream {
    cons: HeapCons<f32>,
    sample_rate: u32,
  },
  Stop,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BandFrame {
  id: String,
  level_db: f32,
  value: f32,
  active: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Frame {
  spectrum: Vec<f32>,
  bands: Vec<BandFrame>,
  peak_db: f32,
  sample_rate: u32,
  running: bool,
}

struct BandState {
  level_db: f32,
  active: bool,
  sent_note: Option<(u8, u8)>,
  // (channel, cc, value) last sent
  sent_cc: Option<(u8, u8, u8)>,
  sent_osc: Option<f32>,
}

impl BandState {
  fn new() -> Self {
    Self {
      level_db: FLOOR_DB,
      active: false,
      sent_note: None,
      sent_cc: None,
      sent_osc: None,
    }
  }

  fn release(&mut self, out: &mut Outputs, m: Option<&Mapping>) {
    if let Some((ch, note)) = self.sent_note.take() {
      out.note_off(ch, note);
    }
    if let Some(m) = m {
      if self.active && m.output == OutputKind::Osc && m.osc_mode == OscMode::Gate {
        out.osc(&m.osc_address, 0.0);
      }
    }
    self.active = false;
  }
}

fn db_to_amp(db: f32) -> f32 {
  10f32.powf(db / 20.0)
}

fn power_to_db(p: f32) -> f32 {
  if p <= 0.0 {
    FLOOR_DB
  } else {
    (10.0 * p.log10()).max(FLOOR_DB)
  }
}

// level of a frequency band, in dBFS (a full-scale sine reads ~0dB)
fn band_db(power: &[f32], low: f32, high: f32, bin_hz: f32) -> f32 {
  let (low, high) = if low <= high {
    (low, high)
  } else {
    (high, low)
  };
  let last = power.len().saturating_sub(1);
  let b0 = ((low / bin_hz).ceil() as usize).min(last);
  let b1 = ((high / bin_hz).floor() as usize).min(last);
  let sum: f32 = if b1 >= b0 {
    power[b0..=b1].iter().sum()
  } else {
    power[(((low + high) / 2.0 / bin_hz).round() as usize).min(last)]
  };
  power_to_db(sum / HANN_ENBW)
}

fn display_spectrum(power: &[f32], bin_hz: f32) -> Vec<f32> {
  let ratio = (DISPLAY_MAX_HZ / DISPLAY_MIN_HZ).powf(1.0 / DISPLAY_POINTS as f32);
  let last = power.len() - 1;
  (0..DISPLAY_POINTS)
    .map(|i| {
      let f0 = DISPLAY_MIN_HZ * ratio.powi(i as i32);
      let f1 = f0 * ratio;
      let b0 = (f0 / bin_hz).ceil() as usize;
      let b1 = (f1 / bin_hz).ceil() as usize;
      if b0 > last {
        return FLOOR_DB;
      }
      let p = if b1 > b0 {
        power[b0..b1.min(last + 1)]
          .iter()
          .cloned()
          .fold(0.0, f32::max)
      } else {
        // fewer bins than display points here, so interpolate
        let b = (f0 * ratio.sqrt()) / bin_hz;
        let i0 = (b.floor() as usize).min(last);
        let i1 = (i0 + 1).min(last);
        let t = b - i0 as f32;
        power[i0] * (1.0 - t) + power[i1] * t
      };
      power_to_db(p)
    })
    .collect()
}

fn normalize(level: f32, min: f32, max: f32) -> f32 {
  if max <= min {
    return if level >= max { 1.0 } else { 0.0 };
  }
  ((level - min) / (max - min)).clamp(0.0, 1.0)
}

fn process_band(m: &Mapping, st: &mut BandState, out: &mut Outputs) -> f32 {
  let level = st.level_db;
  let off_db = m.threshold_db - m.hysteresis_db.max(0.0);
  let was = st.active;
  let active = if was {
    level > off_db
  } else {
    level >= m.threshold_db
  };
  st.active = active;

  // switching away from note output while a note is held
  if m.output != OutputKind::Note {
    if let Some((ch, note)) = st.sent_note.take() {
      out.note_off(ch, note);
    }
  }

  match m.output {
    OutputKind::Note => {
      let vel_norm = normalize(level, m.threshold_db, m.max_db);
      // note/channel edited while held
      if let Some((ch, note)) = st.sent_note {
        if (ch, note) != (m.channel, m.note) {
          out.note_off(ch, note);
          st.sent_note = None;
          st.active = false;
          return vel_norm;
        }
      }
      if active && !was {
        let vel = if m.velocity > 0 {
          m.velocity
        } else {
          1 + (vel_norm * 126.0).round() as u8
        };
        out.note_on(m.channel, m.note, vel);
        st.sent_note = Some((m.channel, m.note));
      } else if !active {
        if let Some((ch, note)) = st.sent_note.take() {
          out.note_off(ch, note);
        }
      }
      if active {
        1.0
      } else {
        0.0
      }
    }
    OutputKind::Cc => {
      let v = normalize(level, m.min_db, m.max_db);
      let val = (v * 127.0).round() as u8;
      let key = (m.channel, m.cc, val);
      if st.sent_cc != Some(key) {
        out.cc(m.channel, m.cc, val);
        st.sent_cc = Some(key);
      }
      v
    }
    OutputKind::Osc => match m.osc_mode {
      OscMode::Value => {
        let v = normalize(level, m.min_db, m.max_db);
        if st.sent_osc.map_or(true, |last| (last - v).abs() >= 0.002) {
          out.osc(&m.osc_address, v);
          st.sent_osc = Some(v);
        }
        v
      }
      OscMode::Gate => {
        if active != was {
          out.osc(&m.osc_address, if active { 1.0 } else { 0.0 });
        }
        if active {
          1.0
        } else {
          0.0
        }
      }
    },
  }
}

pub fn spawn(app: AppHandle, shared: Arc<Shared>, rx: Receiver<AudioMsg>) {
  std::thread::spawn(move || run(app, shared, rx));
}

fn run(app: AppHandle, shared: Arc<Shared>, rx: Receiver<AudioMsg>) {
  let mut planner = FftPlanner::<f32>::new();
  let mut fft: Option<Arc<dyn Fft<f32>>> = None;
  let mut fft_size = 0;
  let mut window: Vec<f32> = vec![];
  let mut window_sum = 1.0;
  let mut buf: Vec<Complex<f32>> = vec![];
  let mut power: Vec<f32> = vec![];
  let mut history = vec![0f32; HISTORY];
  let mut tmp = vec![0f32; HISTORY];
  let mut cons: Option<HeapCons<f32>> = None;
  let mut sample_rate = 48000u32;
  let mut states: HashMap<String, BandState> = HashMap::new();
  let mut last = Instant::now();
  let mut last_emit = Instant::now();
  let mut peak = 0f32;

  loop {
    for msg in rx.try_iter() {
      match msg {
        AudioMsg::Stream {
          cons: c,
          sample_rate: sr,
        } => {
          cons = Some(c);
          sample_rate = sr;
        }
        AudioMsg::Stop => cons = None,
      }
      history.fill(0.0);
    }

    let cfg = shared.config.read().unwrap().clone();
    let gain = db_to_amp(cfg.input_gain_db);

    if let Some(c) = cons.as_mut() {
      loop {
        let n = c.pop_slice(&mut tmp);
        if n == 0 {
          break;
        }
        history.copy_within(n.., 0);
        history[HISTORY - n..].copy_from_slice(&tmp[..n]);
        peak = tmp[..n].iter().fold(peak, |a, s| a.max(s.abs()));
      }
    }

    let size = cfg.fft_size.clamp(256, HISTORY).next_power_of_two();
    if size != fft_size {
      fft_size = size;
      fft = Some(planner.plan_fft_forward(size));
      window = (0..size)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / size as f32).cos())
        .collect();
      window_sum = window.iter().sum();
      buf = vec![Complex::new(0.0, 0.0); size];
      power = vec![0.0; size / 2];
    }

    let start = HISTORY - size;
    for i in 0..size {
      buf[i] = Complex::new(history[start + i] * gain * window[i], 0.0);
    }
    fft.as_ref().unwrap().process(&mut buf);
    // scale so a sine of amplitude A peaks at A
    let norm = 2.0 / window_sum;
    for (k, p) in power.iter_mut().enumerate() {
      let m = buf[k].norm() * norm;
      *p = m * m;
    }
    let bin_hz = sample_rate as f32 / size as f32;

    let now = Instant::now();
    let dt = (now - last).as_secs_f32();
    last = now;

    let mut bands = Vec::with_capacity(cfg.mappings.len());
    {
      let mut out = shared.outputs.lock().unwrap();
      states.retain(|id, st| {
        let m = cfg.mappings.iter().find(|m| &m.id == id && m.enabled);
        if m.is_none() {
          st.release(&mut out, None);
        }
        m.is_some()
      });
      for m in cfg.mappings.iter().filter(|m| m.enabled) {
        let raw = band_db(&power, m.low_hz, m.high_hz, bin_hz);
        let st = states.entry(m.id.clone()).or_insert_with(BandState::new);
        let ms = if raw > st.level_db {
          m.attack_ms
        } else {
          m.release_ms
        };
        let coef = if ms <= 0.0 {
          1.0
        } else {
          1.0 - (-dt / (ms / 1000.0)).exp()
        };
        st.level_db += (raw - st.level_db) * coef;
        let value = process_band(m, st, &mut out);
        bands.push(BandFrame {
          id: m.id.clone(),
          level_db: st.level_db,
          value,
          active: st.active,
        });
      }
    }

    if now - last_emit >= FRAME_INTERVAL {
      last_emit = now;
      let frame = Frame {
        spectrum: display_spectrum(&power, bin_hz),
        bands,
        peak_db: power_to_db(peak * peak * gain * gain),
        sample_rate,
        running: cons.is_some(),
      };
      peak = 0.0;
      let _ = app.emit("frame", frame);
    }

    std::thread::sleep(HOP);
  }
}
