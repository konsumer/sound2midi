mod audio;
mod config;
mod engine;
mod output;

use audio::{AudioHandle, AudioInfo};
use config::Config;
use engine::AudioMsg;
use output::Outputs;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Manager, State};

pub struct Shared {
  pub config: RwLock<Config>,
  pub outputs: Mutex<Outputs>,
}

struct AppState {
  shared: Arc<Shared>,
  audio: Mutex<Option<AudioHandle>>,
  tx: Mutex<Sender<AudioMsg>>,
  config_path: PathBuf,
}

impl AppState {
  fn save(&self) -> Result<(), String> {
    let cfg = self.shared.config.read().unwrap().clone();
    if let Some(dir) = self.config_path.parent() {
      std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&self.config_path, json).map_err(|e| e.to_string())
  }

  fn start_audio(&self) -> Result<AudioInfo, String> {
    let (device, channel) = {
      let cfg = self.shared.config.read().unwrap();
      (cfg.input_device.clone(), cfg.input_channel)
    };
    let mut audio = self.audio.lock().unwrap();
    // drop the old stream first so its Stop reaches the engine before the new Stream
    *audio = None;
    let tx = self.tx.lock().unwrap().clone();
    let handle = audio::start(device, channel, tx)?;
    let info = handle.info.clone();
    *audio = Some(handle);
    Ok(info)
  }

  fn apply(&self, config: Config) -> Result<(), String> {
    *self.shared.config.write().unwrap() = config.clone();
    let out_result = self.shared.outputs.lock().unwrap().configure(&config);
    self.save()?;
    let restart = self
      .audio
      .lock()
      .unwrap()
      .as_ref()
      .is_some_and(|a| a.device != config.input_device || a.channel != config.input_channel);
    if restart {
      self.start_audio()?;
    }
    out_result
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MidiPorts {
  ports: Vec<String>,
  virtual_supported: bool,
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
  state.shared.config.read().unwrap().clone()
}

#[tauri::command]
fn set_config(state: State<AppState>, config: Config) -> Result<(), String> {
  state.apply(config)
}

#[tauri::command]
fn list_inputs() -> Result<Vec<String>, String> {
  audio::list_inputs()
}

#[tauri::command]
fn list_midi_outputs() -> Result<MidiPorts, String> {
  Ok(MidiPorts {
    ports: output::list_midi_ports()?,
    virtual_supported: output::virtual_supported(),
  })
}

#[tauri::command]
fn start_audio(state: State<AppState>) -> Result<AudioInfo, String> {
  state.start_audio()
}

#[tauri::command]
fn stop_audio(state: State<AppState>) {
  *state.audio.lock().unwrap() = None;
}

#[tauri::command]
fn reconnect_outputs(state: State<AppState>) -> Result<(), String> {
  let cfg = state.shared.config.read().unwrap().clone();
  let mut out = state.shared.outputs.lock().unwrap();
  out.reset();
  out.configure(&cfg)
}

#[tauri::command]
fn panic(state: State<AppState>) {
  state.shared.outputs.lock().unwrap().all_notes_off();
}

#[tauri::command]
fn save_preset(state: State<AppState>, path: String) -> Result<(), String> {
  let cfg = state.shared.config.read().unwrap().clone();
  let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
  std::fs::write(path, json).map_err(|e| e.to_string())
}

// presets carry mappings and analysis settings, but keep this machine's devices
#[tauri::command]
fn load_preset(state: State<AppState>, path: String) -> Result<Config, String> {
  let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
  let preset: Config = serde_json::from_str(&text).map_err(|e| e.to_string())?;
  let current = state.shared.config.read().unwrap().clone();
  let config = Config {
    input_device: current.input_device,
    input_channel: current.input_channel,
    midi_output: current.midi_output,
    osc_host: current.osc_host,
    osc_port: current.osc_port,
    ..preset
  };
  state.apply(config.clone())?;
  Ok(config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let config_path = app.path().app_config_dir()?.join("config.json");
      let config: Config = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
      let mut outputs = Outputs::default();
      if let Err(e) = outputs.configure(&config) {
        eprintln!("output setup: {e}");
      }
      let shared = Arc::new(Shared {
        config: RwLock::new(config),
        outputs: Mutex::new(outputs),
      });
      let (tx, rx) = mpsc::channel();
      engine::spawn(app.handle().clone(), shared.clone(), rx);
      app.manage(AppState {
        shared,
        audio: Mutex::new(None),
        tx: Mutex::new(tx),
        config_path,
      });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_config,
      set_config,
      list_inputs,
      list_midi_outputs,
      start_audio,
      stop_audio,
      reconnect_outputs,
      panic,
      save_preset,
      load_preset
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
