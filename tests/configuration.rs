use jacket_zed::server_options;
use zed_extension_api::{serde_json::json, settings::LspSettings};

#[test]
fn region_proxy_preserves_server_arguments_and_environment() {
    let directory = std::path::Path::new("extension work");
    let command = jacket_zed::region_proxy_command(
        "node".into(),
        directory,
        zed_extension_api::Command {
            command: "C:/Jacket Tools/jailsp.exe".into(),
            args: vec!["--example".into(), "value with spaces".into()],
            env: vec![("JAI_STDLIB".into(), "C:/Jai Tools/stdlib".into())],
        },
    );
    assert_eq!(command.command, "node");
    assert_eq!(
        command.args,
        vec![
            directory
                .join("jai-region-proxy.cjs")
                .to_string_lossy()
                .into_owned(),
            "extension work".into(),
            "C:/Jacket Tools/jailsp.exe".into(),
            "--example".into(),
            "value with spaces".into(),
        ]
    );
    assert_eq!(
        command.env,
        vec![("JAI_STDLIB".into(), "C:/Jai Tools/stdlib".into())]
    );
}

#[test]
fn compile_time_execution_is_opt_in() {
    let settings = LspSettings::default();
    assert_eq!(
        server_options(&settings).unwrap(),
        json!({ "trusted": false })
    );
}

#[test]
fn workspace_settings_merge_with_initialization_options() {
    let settings = LspSettings {
        initialization_options: Some(json!({
            "completion": { "autoImport": false, "callSnippets": "none" },
            "trusted": true
        })),
        settings: Some(json!({ "jai": {
            "completion": { "autoImport": true },
            "formatter": { "path": "C:/Jacket/bin/jaifmt.exe" }
        }})),
        ..Default::default()
    };
    assert_eq!(
        server_options(&settings).unwrap(),
        json!({
            "trusted": true,
            "completion": { "autoImport": true, "callSnippets": "none" },
            "formatter": { "path": "C:/Jacket/bin/jaifmt.exe" }
        })
    );
}

#[test]
fn invalid_options_report_the_setting_name() {
    let settings = LspSettings {
        settings: Some(json!({ "jai": [] })),
        ..Default::default()
    };
    assert!(server_options(&settings)
        .unwrap_err()
        .contains("settings.jai"));
}

#[test]
fn invalid_configuration_and_trust_are_rejected() {
    for (initial, configuration, message) in [
        (json!([]), json!({}), "initialization_options"),
        (json!({}), json!([]), "settings"),
        (json!({"trusted": "false"}), json!({}), "trusted"),
        (json!({}), json!({"jai":{"trusted":null}}), "trusted"),
    ] {
        let settings = LspSettings {
            initialization_options: Some(initial),
            settings: Some(configuration),
            ..Default::default()
        };
        assert!(server_options(&settings).unwrap_err().contains(message));
    }
}

#[test]
fn workspace_can_disable_initialization_trust() {
    let settings = LspSettings {
        initialization_options: Some(json!({"trusted":true})),
        settings: Some(json!({"jai":{"trusted":false}})),
        ..Default::default()
    };
    assert_eq!(server_options(&settings).unwrap()["trusted"], false);
}
