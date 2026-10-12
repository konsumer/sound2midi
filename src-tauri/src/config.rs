use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputKind {
  Note,
  Cc,
  Osc,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OscMode {
  // continuous 0..1 level
  Value,
  // 1 when band crosses threshold, 0 when it falls back
  Gate,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Mapping {
  pub id: String,
  pub name: String,
  pub color: String,
  pub enabled: bool,
  pub low_hz: f32,
  pub high_hz: f32,
  pub threshold_db: f32,
  pub hysteresis_db: f32,
  pub min_db: f32,
  pub max_db: f32,
  pub attack_ms: f32,
  pub release_ms: f32,
  pub output: OutputKind,
  pub channel: u8,
  pub note: u8,
  // 0 means velocity follows level
  pub velocity: u8,
  pub cc: u8,
  pub osc_address: String,
  pub osc_mode: OscMode,
}

impl Default for Mapping {
  fn default() -> Self {
    Self {
      id: "band".into(),
      name: "Band".into(),
      color: "#4fd1c5".into(),
      enabled: true,
      low_hz: 200.0,
      high_hz: 400.0,
      threshold_db: -30.0,
      hysteresis_db: 6.0,
      min_db: -60.0,
      max_db: -10.0,
      attack_ms: 5.0,
      release_ms: 80.0,
      output: OutputKind::Note,
      channel: 1,
      note: 60,
      velocity: 0,
      cc: 1,
      osc_address: "/sound2midi/band".into(),
      osc_mode: OscMode::Value,
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
  pub input_device: Option<String>,
  // 0 = mix all channels, n = only channel n
  pub input_channel: u16,
  pub input_gain_db: f32,
  pub fft_size: usize,
  pub midi_output: Option<String>,
  pub osc_host: String,
  pub osc_port: u16,
  pub mappings: Vec<Mapping>,
}

impl Default for Config {
  fn default() -> Self {
    Self {
      input_device: None,
      input_channel: 0,
      input_gain_db: 0.0,
      fft_size: 2048,
      midi_output: None,
      osc_host: "127.0.0.1".into(),
      osc_port: 9000,
      mappings: vec![
        Mapping {
          id: "kick".into(),
          name: "Kick".into(),
          color: "#f6ad55".into(),
          low_hz: 40.0,
          high_hz: 120.0,
          note: 36,
          ..Default::default()
        },
        Mapping {
          id: "mids".into(),
          name: "Mids".into(),
          color: "#4fd1c5".into(),
          low_hz: 500.0,
          high_hz: 2000.0,
          output: OutputKind::Cc,
          cc: 1,
          release_ms: 150.0,
          ..Default::default()
        },
        Mapping {
          id: "hats".into(),
          name: "Hats".into(),
          color: "#b794f4".into(),
          low_hz: 7000.0,
          high_hz: 14000.0,
          threshold_db: -40.0,
          output: OutputKind::Osc,
          osc_address: "/sound2midi/hats".into(),
          osc_mode: OscMode::Gate,
          ..Default::default()
        },
      ],
    }
  }
}
