use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

#[test]
fn zed_queries_match_the_pinned_grammar() {
    let language = tree_sitter_jai::LANGUAGE.into();
    for (name, source) in [
        (
            "highlights",
            include_str!("../languages/jai/highlights.scm"),
        ),
        ("brackets", include_str!("../languages/jai/brackets.scm")),
        ("indents", include_str!("../languages/jai/indents.scm")),
        ("outline", include_str!("../languages/jai/outline.scm")),
        ("overrides", include_str!("../languages/jai/overrides.scm")),
        (
            "textobjects",
            include_str!("../languages/jai/textobjects.scm"),
        ),
        ("runnables", include_str!("../languages/jai/runnables.scm")),
    ] {
        Query::new(&language, source).unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn basic_jacket_source_parses() {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_jai::LANGUAGE.into())
        .unwrap();
    let tree = parser
        .parse(include_str!("fixtures/basic.jai"), None)
        .unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
}

fn captures(query: &str) -> Vec<(String, String)> {
    captures_in(include_str!("fixtures/basic.jai"), query)
}

fn captures_in(source: &str, query: &str) -> Vec<(String, String)> {
    let language = tree_sitter_jai::LANGUAGE.into();
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = parser.parse(source, None).unwrap();
    let query = Query::new(&language, query).unwrap();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
    let mut captures = Vec::new();
    while let Some(found) = matches.next() {
        for capture in found.captures {
            captures.push((
                query.capture_names()[capture.index as usize].to_string(),
                source[capture.node.byte_range()].to_string(),
            ));
        }
    }
    captures
}

#[test]
fn region_outline_fallback_lists_starts_and_preserves_declarations() {
    let names: Vec<_> = captures_in(
        include_str!("fixtures/paired_regions.jai"),
        include_str!("../languages/jai/outline.scm"),
    )
    .into_iter()
    .filter(|(kind, _)| kind == "name")
    .map(|(_, name)| name)
    .collect();
    assert_eq!(
        names,
        [
            "//@region UI",
            "//@region Types",
            "Gallery",
            "//@region Drawing",
            "draw",
            "//@region State",
            "main",
        ]
    );
    let false_markers = captures_in(
        "s :: \"//@region Fake\";\n/* //@region Fake */\n//@region\n//@endregion\n",
        include_str!("../languages/jai/outline.scm"),
    );
    assert!(false_markers.is_empty());
}

#[test]
fn outline_lists_declarations_and_not_calls() {
    let names: Vec<_> = captures(include_str!("../languages/jai/outline.scm"))
        .into_iter()
        .filter(|(kind, _)| kind == "name")
        .map(|(_, name)| name)
        .collect();
    assert_eq!(names, ["Point", "Color", "add", "main"]);
}

#[test]
fn only_main_gets_a_run_button() {
    assert_eq!(
        captures(include_str!("../languages/jai/runnables.scm")),
        vec![("run".into(), "main".into())]
    );
}

#[test]
fn function_textobjects_include_the_body_without_braces() {
    let captures = captures(include_str!("../languages/jai/textobjects.scm"));
    assert!(captures.iter().any(|(kind, text)| kind == "function.around"
        && text.starts_with("add ::")
        && text.ends_with('}')));
    assert!(captures
        .iter()
        .any(|(kind, text)| kind == "function.inside" && text == "return a + b;"));
    assert!(captures
        .iter()
        .any(|(kind, text)| kind == "class.around" && text.starts_with("Point ::")));
}

#[test]
fn struct_field_and_type_identifiers_have_specific_highlights() {
    let source = include_str!("fixtures/highlights.jai");
    let language = tree_sitter_jai::LANGUAGE.into();
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = parser.parse(source, None).unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
    let query = Query::new(&language, include_str!("../languages/jai/highlights.scm")).unwrap();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, tree.root_node(), source.as_bytes());
    let mut highlights = std::collections::BTreeMap::new();
    while let Some(found) = matches.next() {
        for capture in found.captures {
            // A capture of an enclosing `types` node is insufficient: its child
            // identifier's generic @variable capture can hide it in Zed.
            if capture.node.kind() == "identifier" {
                let entry = highlights
                    .entry((capture.node.start_byte(), capture.node.end_byte()))
                    .or_insert((0, "variable"));
                if found.pattern_index >= entry.0 {
                    *entry = (
                        found.pattern_index,
                        query.capture_names()[capture.index as usize],
                    );
                }
            }
        }
    }
    for (range, (_, highlight)) in &highlights {
        let text = &source[range.0..range.1];
        let expected = match text {
            "Gallery" | "UI_Context" | "UI_Theme" | "Material_library" | "Render2D" | "Texture"
            | "Msdf_Font" | "bool" | "int" | "float32" | "u8" | "Table" => "type",
            "ui" | "theme" | "materials" | "renderer" | "font_texture" | "font_view" | "ready"
            | "renderer_ready" | "started" | "failed" | "frames" | "checks" | "scale" | "music"
            | "volume" | "name" | "items" | "fixed" | "table" | "copied" => "property",
            "local_count" | "initial_value" => "variable",
            "MAX_COUNT" => "constant",
            _ => continue,
        };
        assert_eq!(
            *highlight, expected,
            "wrong highlight for {text} at {range:?}"
        );
    }
    assert!(
        highlights.len() > 40,
        "expected to capture the fixture's identifiers"
    );
}
