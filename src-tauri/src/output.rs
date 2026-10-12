use crate::config::Config;
use midir::{MidiOutput, MidiOutputConnection};
use rosc::{encoder, OscMessage, OscPacket, OscType};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};

pub const VIRTUAL_PORT: &str = "__virtual__";
const CLIENT_NAME: &str = "sound2midi";

#[derive(Default)]
pub struct Outputs {
  midi: Option<MidiOutputConnection>,
  midi_key: Option<String>,
  socket: Option<UdpSocket>,
  osc_target: Option<SocketAddr>,
  osc_key: String,
  #[cfg(test)]
  pub sent: Vec<Vec<u8>>,
}

pub fn list_midi_ports() -> Result<Vec<String>, String> {
  let out = MidiOutput::new(CLIENT_NAME).map_err(|e| e.to_string())?;
  Ok(
    out
      .ports()
      .iter()
      .filter_map(|p| out.port_name(p).ok())
      .collect(),
  )
}

pub fn virtual_supported() -> bool {
  cfg!(unix)
}

fn connect_midi(name: &str) -> Result<MidiOutputConnection, String> {
  let out = MidiOutput::new(CLIENT_NAME).map_err(|e| e.to_string())?;
  if name == VIRTUAL_PORT {
    #[cfg(unix)]
    {
      use midir::os::unix::VirtualOutput;
      return out.create_virtual(CLIENT_NAME).map_err(|e| e.to_string());
    }
    #[cfg(not(unix))]
    return Err("Virtual MIDI ports are not supported on this platform".into());
  }
  let port = out
    .ports()
    .into_iter()
    .find(|p| out.port_name(p).ok().as_deref() == Some(name))
    .ok_or(format!("MIDI port not found: {name}"))?;
  out
    .connect(&port, "sound2midi-out")
    .map_err(|e| e.to_string())
}

impl Outputs {
  // forget current connections so the next configure() reconnects
  pub fn reset(&mut self) {
    self.all_notes_off();
    self.midi = None;
    self.midi_key = None;
    self.osc_key.clear();
  }

  pub fn configure(&mut self, cfg: &Config) -> Result<(), String> {
    let mut errors = vec![];

    if cfg.midi_output != self.midi_key {
      self.all_notes_off();
      self.midi = None;
      self.midi_key = cfg.midi_output.clone();
      if let Some(name) = cfg.midi_output.as_deref().filter(|n| !n.is_empty()) {
        match connect_midi(name) {
          Ok(c) => self.midi = Some(c),
          Err(e) => errors.push(e),
        }
      }
    }

    let key = format!("{}:{}", cfg.osc_host, cfg.osc_port);
    if key != self.osc_key {
      self.osc_key = key.clone();
      self.osc_target = None;
      if self.socket.is_none() {
        match UdpSocket::bind("0.0.0.0:0") {
          Ok(s) => self.socket = Some(s),
          Err(e) => errors.push(format!("OSC socket: {e}")),
        }
      }
      match key.to_socket_addrs().map(|mut a| a.next()) {
        Ok(Some(addr)) => self.osc_target = Some(addr),
        _ => errors.push(format!("Invalid OSC target: {key}")),
      }
    }

    if errors.is_empty() {
      Ok(())
    } else {
      Err(errors.join("; "))
    }
  }

  fn midi_send(&mut self, msg: &[u8]) {
    #[cfg(test)]
    self.sent.push(msg.to_vec());
    if let Some(conn) = self.midi.as_mut() {
      let _ = conn.send(msg);
    }
  }

  pub fn raw(&mut self, msg: &[u8]) {
    if !msg.is_empty() {
      self.midi_send(msg);
    }
  }

  pub fn note_on(&mut self, channel: u8, note: u8, velocity: u8) {
    let ch = channel.clamp(1, 16) - 1;
    self.midi_send(&[0x90 | ch, note & 0x7f, velocity.clamp(1, 127)]);
  }

  pub fn note_off(&mut self, channel: u8, note: u8) {
    let ch = channel.clamp(1, 16) - 1;
    self.midi_send(&[0x80 | ch, note & 0x7f, 0]);
  }

  pub fn cc(&mut self, channel: u8, cc: u8, value: u8) {
    let ch = channel.clamp(1, 16) - 1;
    self.midi_send(&[0xb0 | ch, cc & 0x7f, value & 0x7f]);
  }

  pub fn all_notes_off(&mut self) {
    for ch in 1..=16 {
      self.cc(ch, 123, 0);
    }
  }

  pub fn osc(&mut self, addr: &str, value: f32) {
    let (Some(socket), Some(target)) = (self.socket.as_ref(), self.osc_target) else {
      return;
    };
    if !addr.starts_with('/') {
      return;
    }
    let packet = OscPacket::Message(OscMessage {
      addr: addr.to_string(),
      args: vec![OscType::Float(value)],
    });
    if let Ok(buf) = encoder::encode(&packet) {
      let _ = socket.send_to(&buf, target);
    }
  }
}
