//! The result of one transpile as JSON text. The module exports and the native
//! comparison program build the text with this code, so equal text means equal
//! results.
//!
//! The line map keeps its tokens private. The module keeps the map between
//! calls and answers one printed position at a time. The native program lists
//! the answers with `line_map_runs`.

use std::fmt::{Display, Write};

use rustel_transpiler::{
    LineMap, ParseDiagnostic, RegistrationHints, TranspileOptions, TranspileOutput,
    VISUAL_WIDGET_METHODS, WidgetRecord,
};

/// The options of the engine session for a score. The session sets the visual
/// widget methods, in file `crates/runtime/src/session/evaluation.rs` of the
/// engine repository. The script runtime forces `add_return` and
/// `allow_module_syntax` off, in `transpile_score` of file
/// `crates/jsruntime/src/runtime/evaluation.rs`. Every other option keeps its
/// default.
pub fn score_options() -> TranspileOptions {
    TranspileOptions {
        widget_methods: VISUAL_WIDGET_METHODS
            .iter()
            .map(|method| (*method).to_owned())
            .collect(),
        add_return: false,
        allow_module_syntax: false,
        ..TranspileOptions::default()
    }
}

/// One transpile.
pub struct Run {
    /// The engine result. `output.output` is the text every position refers
    /// to: the mini-notation locations, the widget records, the diagnostics
    /// and the line map.
    pub output: TranspileOutput,
    /// True when `output.output` holds an `await`.
    pub awaits: bool,
    /// The text a host evaluates: `output.output` with the final return of the
    /// engine, so the function which wraps the text gives the pattern back.
    /// The return shifts the last expression by 7 characters on its line, and
    /// a last statement which is no expression adds a line. Empty when the
    /// score has diagnostics, since a refused score has nothing to run.
    pub body: String,
}

/// Transpiles one score as the script runtime does, then asks the question the
/// runtime asks of the output text (does the code hold an `await`) and adds the
/// final return the evaluator of the engine adds. The text of a score which the
/// engine refuses gets no body.
pub fn run(source: &str) -> Run {
    let output = rustel_transpiler::transpile(source, &score_options());
    let awaits = rustel_transpiler::awaits_in_code(&output.output);
    let body = if output.diagnostics.is_empty() {
        rustel_transpiler::add_final_return_or_undefined(&output.output)
    } else {
        String::new()
    };
    Run {
        output,
        awaits,
        body,
    }
}

/// Every field a host reads, except the line map, as one JSON object.
pub fn encode(run: &Run) -> String {
    let result = &run.output;
    let mut out = String::with_capacity(result.output.len() * 3 + 256);
    out.push_str("{\"output\":");
    string(&mut out, &result.output);
    out.push_str(",\"body\":");
    string(&mut out, &run.body);
    let awaits = run.awaits;
    let _ = write!(out, ",\"awaits\":{awaits},\"mini_locations\":[");
    for (index, (from, to)) in result.mini_locations.iter().enumerate() {
        comma(&mut out, index);
        let _ = write!(out, "[{from},{to}]");
    }
    out.push_str("],\"diagnostics\":[");
    for (index, diagnostic) in result.diagnostics.iter().enumerate() {
        comma(&mut out, index);
        diagnostic_json(&mut out, diagnostic);
    }
    out.push_str("],\"widgets\":[");
    for (index, widget) in result.widgets.iter().enumerate() {
        comma(&mut out, index);
        widget_json(&mut out, widget);
    }
    out.push_str("],\"registrations\":");
    registrations_json(&mut out, &result.registrations);
    out.push('}');
    out
}

/// The answers of a line map over every printed position of `output`, as runs.
///
/// Lines split at `\n`. A position is a column from 0 to the byte length of
/// its line. A run starts where the answer changes. Each run is
/// `[line, column, source_line, source_column]`, with -1 twice for no answer.
pub fn line_map_runs(map: &LineMap, output: &str) -> Vec<[i64; 4]> {
    let mut runs = Vec::new();
    for (line, text) in output.split('\n').enumerate() {
        let mut previous = None;
        for column in 0..=text.len() {
            let answer = map.original_position(line as u32, column as u32);
            if previous != Some(answer) {
                let (source_line, source_column) = answer.map_or((-1, -1), |(line, column)| {
                    (i64::from(line), i64::from(column))
                });
                runs.push([line as i64, column as i64, source_line, source_column]);
                previous = Some(answer);
            }
        }
    }
    runs
}

fn comma(out: &mut String, index: usize) {
    if index > 0 {
        out.push(',');
    }
}

fn diagnostic_json(out: &mut String, diagnostic: &ParseDiagnostic) {
    out.push_str("{\"message\":");
    string(out, &diagnostic.message);
    out.push_str(",\"offset\":");
    number(out, diagnostic.offset);
    out.push('}');
}

fn registrations_json(out: &mut String, hints: &RegistrationHints) {
    out.push_str("{\"names\":[");
    for (index, name) in hints.names.iter().enumerate() {
        comma(out, index);
        string(out, name);
    }
    let _ = write!(
        out,
        "],\"has_dynamic_names\":{},\"final_expression_is_registration\":{}}}",
        hints.has_dynamic_names, hints.final_expression_is_registration
    );
}

fn widget_json(out: &mut String, widget: &WidgetRecord) {
    let _ = write!(
        out,
        "{{\"from\":{},\"to\":{},\"call_from\":{},\"call_to\":{},\"index\":{},\"widget_type\":",
        widget.from, widget.to, widget.call_from, widget.call_to, widget.index
    );
    string(out, &widget.widget_type);
    out.push_str(",\"id\":");
    string(out, &widget.id);
    out.push_str(",\"visual_slot\":");
    number(out, widget.visual_slot);
    out.push_str(",\"value\":");
    optional_string(out, widget.value.as_deref());
    out.push_str(",\"min\":");
    float(out, widget.min);
    out.push_str(",\"max\":");
    float(out, widget.max);
    out.push_str(",\"step\":");
    float(out, widget.step);
    out.push_str(",\"options\":");
    optional_string(out, widget.options.as_deref());
    out.push_str(",\"label\":");
    optional_string(out, widget.label.as_deref());
    let _ = write!(
        out,
        ",\"deferred_rendering\":{},\"frequency\":{}}}",
        widget.deferred_rendering, widget.frequency
    );
}

fn number<T: Display>(out: &mut String, value: Option<T>) {
    match value {
        Some(value) => {
            let _ = write!(out, "{value}");
        }
        None => out.push_str("null"),
    }
}

/// A number, or `null`. JSON has no spelling for a value which is not finite.
fn float(out: &mut String, value: Option<f64>) {
    number(out, value.filter(|value| value.is_finite()));
}

fn optional_string(out: &mut String, value: Option<&str>) {
    match value {
        Some(value) => string(out, value),
        None => out.push_str("null"),
    }
}

/// Appends a JSON string. A control character other than `\n`, `\r` and `\t`
/// becomes a `\u` escape.
pub fn string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", control as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_is_one_object_with_null_for_what_is_missing() {
        let result = TranspileOutput {
            output: "s('a\"b');\n\u{1}".to_owned(),
            mini_locations: vec![(3, 4)],
            diagnostics: vec![
                ParseDiagnostic {
                    message: "a \\ b".to_owned(),
                    offset: None,
                },
                ParseDiagnostic {
                    message: "c".to_owned(),
                    offset: Some(7),
                },
            ],
            widgets: vec![WidgetRecord {
                from: 1,
                to: 2,
                call_from: 0,
                call_to: 3,
                index: 0,
                widget_type: "slider".to_owned(),
                id: "w0".to_owned(),
                visual_slot: None,
                value: Some("5".to_owned()),
                min: Some(f64::NAN),
                max: Some(1.5),
                step: None,
                options: None,
                label: Some("lpf".to_owned()),
                deferred_rendering: false,
                frequency: true,
            }],
            registrations: RegistrationHints {
                names: vec!["a".to_owned()],
                has_dynamic_names: false,
                final_expression_is_registration: true,
            },
            ..TranspileOutput::default()
        };
        let run = Run {
            output: result,
            awaits: true,
            body: "return s('a');".to_owned(),
        };
        assert_eq!(
            encode(&run),
            concat!(
                r#"{"output":"s('a\"b');\n\u0001","body":"return s('a');","#,
                r#""awaits":true,"mini_locations":[[3,4]],"#,
                r#""diagnostics":[{"message":"a \\ b","offset":null},{"message":"c","offset":7}],"#,
                r#""widgets":[{"from":1,"to":2,"call_from":0,"call_to":3,"index":0,"#,
                r#""widget_type":"slider","id":"w0","visual_slot":null,"value":"5","min":null,"#,
                r#""max":1.5,"step":null,"options":null,"label":"lpf","#,
                r#""deferred_rendering":false,"frequency":true}],"#,
                r#""registrations":{"names":["a"],"has_dynamic_names":false,"#,
                r#""final_expression_is_registration":true}}"#
            )
        );
    }

    #[test]
    fn the_body_has_the_final_return_and_a_refused_score_has_none() {
        assert_eq!(run("s(\"bd\")").body, "return s(m('bd', 2));");
        assert_eq!(run("const x = 1;").body, "const x = 1;\nreturn silence;");
        // A score with no statement names no pattern, so the body stays as is.
        let empty = run("// nothing");
        assert_eq!(empty.body, empty.output.output);
        let refused = run("s(\"bd\"");
        assert!(!refused.output.diagnostics.is_empty());
        assert_eq!(refused.body, "");
    }
}
