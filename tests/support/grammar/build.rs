use std::{env, path::Path, process::Command};

const REVISION: &str = "3f8ee754d6531a1672d9e36cd54e81580fcec02c";
const REPOSITORY: &str = "https://github.com/constantitus/tree-sitter-jai";

fn git(directory: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(directory)
        .args(args)
        .status()
        .expect("grammar tests require Git");
    assert!(
        status.success(),
        "grammar test dependency: git {args:?} failed"
    );
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let output = std::path::PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let checkout = output.join("upstream");
    std::fs::create_dir_all(&checkout).unwrap();
    if !checkout.join(".git").exists() {
        git(&checkout, &["init", "--quiet"]);
    }
    if std::fs::read_to_string(checkout.join("ready"))
        .ok()
        .as_deref()
        != Some(REVISION)
        || !checkout.join("src/parser.c").is_file()
        || !checkout.join("src/scanner.c").is_file()
    {
        git(
            &checkout,
            &["fetch", "--quiet", "--depth=1", REPOSITORY, REVISION],
        );
        git(&checkout, &["checkout", "--quiet", "--detach", REVISION]);
        std::fs::write(checkout.join("ready"), REVISION).unwrap();
    }
    let mut build = cc::Build::new();
    build
        .include(checkout.join("src"))
        .file(checkout.join("src/parser.c"))
        .file(checkout.join("src/scanner.c"))
        .warnings(false);
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        build.flag("/utf-8");
    }
    build.compile("jai_test_grammar");
}
