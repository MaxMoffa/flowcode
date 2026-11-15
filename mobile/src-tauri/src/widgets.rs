//! Home-screen widgets: the bridge to the Kotlin `WidgetPlugin`. The webview
//! pushes a stats snapshot (the widgets draw themselves from it) and asks which
//! widget button opened the app. Elsewhere both calls are no-ops.

#[cfg(target_os = "android")]
use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, State, Wry};

#[derive(Clone)]
pub struct Widgets {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<Wry>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct UpdatePayload {
    snapshot: String,
}

// `(async)`: the plugin calls block.
#[tauri::command(async)]
pub fn widgets_update(widgets: State<'_, Widgets>, snapshot: serde_json::Value) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return widgets.handle.run_mobile_plugin::<()>("update", UpdatePayload { snapshot: snapshot.to_string() }).map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (widgets, snapshot);
        Ok(())
    }
}

/// The widget action that opened the app, once; `None` when there is none.
#[tauri::command(async)]
pub fn widgets_take_action(widgets: State<'_, Widgets>) -> Result<Option<serde_json::Value>, String> {
    #[cfg(target_os = "android")]
    {
        let reply = widgets.handle.run_mobile_plugin::<serde_json::Value>("takeAction", ()).map_err(|e| e.to_string())?;
        return Ok(if reply.get("action").is_some() { Some(reply) } else { None });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = widgets;
        Ok(None)
    }
}

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("widgets")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.maxmoffa.flowcode.mobile", "WidgetPlugin")?;
                app.manage(Widgets { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Widgets {});
            }
            Ok(())
        })
        .build()
}
