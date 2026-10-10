//! `JSON.stringify` of a host value, for the names which hand a dictionary
//! to the engine as JSON text (`addVoicings`, `midimaps`).

use crate::binding::tape::Arg;
use rustel_core::Value;

/// The text, or `None` for a value `JSON.stringify` answers `undefined` for
/// (undefined and a function).
pub fn stringify(arg: &Arg) -> Option<String> {
    let mut out = String::new();
    write(arg, &mut out).then_some(out)
}

fn write(arg: &Arg, out: &mut String) -> bool {
    match arg {
        Arg::Undefined | Arg::Func(_) => return false,
        Arg::Null => out.push_str("null"),
        Arg::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Arg::Num(number) if number.is_finite() => out.push_str(&Value::F64(*number).show()),
        Arg::Num(_) => out.push_str("null"),
        Arg::Str(text) => quote(text, out),
        Arg::List(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                // A member which has no JSON form is `null` in a list.
                if !write(item, out) {
                    out.push_str("null");
                }
            }
            out.push(']');
        }
        Arg::Object(members) => {
            out.push('{');
            let mut first = true;
            for (key, value) in members {
                let mark = out.len();
                if !first {
                    out.push(',');
                }
                quote(key, out);
                out.push(':');
                if write(value, out) {
                    first = false;
                } else {
                    out.truncate(mark);
                }
            }
            out.push('}');
        }
        // These objects have no enumerable member of use here.
        Arg::Pattern(_) | Arg::Frac(_) | Arg::Span(_) | Arg::Hap(_) | Arg::State(_) => {
            out.push_str("{}");
        }
    }
    true
}

fn quote(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            control if control < ' ' => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}
