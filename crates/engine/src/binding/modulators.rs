//! The modulators `lfo`, `env`, `bmod` and the method `modulate`.
//! Source: `install/native_surface/modulation.rs`.
//!
//! A modulator call adds one entry to the `lfo`, `env` or `bmod` object of
//! every value. The call is a chain of left applications, one for each key of
//! its settings, over a value of `[controls, id]`.

use crate::binding::natives::Call;
use crate::binding::reify::reify_bridged;
use crate::binding::tape::Arg;
use rustel_core::controls::default_control_registry;
use rustel_core::{OrderedMap, Pattern, Value, materialize_js_value, pure};
use std::sync::{Arc, Mutex};

/// The long name of a setting key. A key which is no short form stays.
fn subcontrol(kind: &str, key: &str) -> String {
    let key = key.to_lowercase();
    let canonical = match kind {
        "lfo" => match key.as_str() {
            "c" => "control",
            "sc" => "subControl",
            "r" => "rate",
            "dep" | "dr" => "depth",
            "da" => "depthabs",
            "dc" => "dcoffset",
            "sh" => "shape",
            "sk" => "skew",
            "cu" => "curve",
            "s" => "sync",
            "rt" => "retrig",
            _ => key.as_str(),
        },
        "env" => match key.as_str() {
            "c" => "control",
            "sc" => "subControl",
            "att" | "a" => "attack",
            "dec" | "d" => "decay",
            "sus" | "s" => "sustain",
            "rel" | "r" => "release",
            "dep" | "dr" => "depth",
            "da" => "depthabs",
            "ac" => "acurve",
            "dc" => "dcurve",
            "rc" => "rcurve",
            _ => key.as_str(),
        },
        "bmod" => match key.as_str() {
            "b" => "bus",
            "c" => "control",
            "sc" => "subControl",
            "dep" | "dr" => "depth",
            "da" => "depthabs",
            _ => key.as_str(),
        },
        _ => key.as_str(),
    };
    canonical.to_owned()
}

/// A value as a property key of an object.
fn property_key(value: &Value) -> String {
    match materialize_js_value(value) {
        Value::Str(value) => value,
        Value::F64(value) => Value::F64(value).show(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".into(),
        Value::Undefined => "undefined".into(),
        _ => "[object Object]".into(),
    }
}

fn canonical_control(value: &Value) -> Value {
    match materialize_js_value(value) {
        Value::Str(value) => Value::Str(
            default_control_registry()
                .canonical_name(&value)
                .unwrap_or(&value)
                .to_owned(),
        ),
        value => value,
    }
}

fn append(left: &Value, right: &Value) -> Value {
    let mut values = match materialize_js_value(left) {
        Value::List(values) => values,
        value => vec![value],
    };
    values.push(materialize_js_value(right));
    Value::List(values)
}

fn apply_setting(
    pair: &Value,
    setting: &Value,
    kind: &'static str,
    key: &str,
    default: &Mutex<Option<Value>>,
) -> Value {
    let Value::List(mut pair) = materialize_js_value(pair) else {
        rustel_core::signal_query_error(|| "invalid modulator state".into());
        return Value::Undefined;
    };
    if pair.len() < 2 {
        rustel_core::signal_query_error(|| "invalid modulator state".into());
        return Value::Undefined;
    }
    let mut controls = match pair.remove(0) {
        Value::Object(controls) => controls,
        _ => {
            rustel_core::signal_query_error(|| "modulate expects object-valued haps".into());
            return Value::Undefined;
        }
    };
    let mut id = pair.remove(0);
    // The control a modulator without a `control` setting points at: the last
    // control of the value.
    let default_value = {
        let mut stored = default
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if stored.is_none() {
            let mut value = controls
                .js_entries()
                .last()
                .map(|(name, _)| {
                    Value::Str(
                        default_control_registry()
                            .canonical_name(name)
                            .unwrap_or(name)
                            .to_owned(),
                    )
                })
                .unwrap_or(Value::Undefined);
            if let Value::Str(control) = &value
                && matches!(control.as_str(), "lfo" | "env" | "bmod")
                && let Some(Value::Object(modulator)) = controls.get(control)
                && let Some((last, _)) = modulator
                    .js_entries()
                    .into_iter()
                    .rfind(|(name, _)| *name != "__ids")
            {
                value = Value::Str(format!("{control}_{last}"));
            }
            *stored = Some(value);
        }
        stored.clone().unwrap_or(Value::Undefined)
    };
    let mut modulator = match controls.get(kind).cloned() {
        Some(Value::Object(value)) => value,
        _ => OrderedMap::from_entries([("__ids".into(), Value::Object(OrderedMap::new()))]),
    };
    let ids = modulator
        .js_entries()
        .into_iter()
        .filter(|(name, _)| *name != "__ids")
        .count();
    if id.is_nullish() {
        id = Value::F64(ids as f64);
    }
    let id_key = property_key(&id);
    let mut entry = match modulator.get(&id_key).cloned() {
        Some(Value::Object(entry)) => entry,
        _ => OrderedMap::from_entries([("control".into(), default_value)]),
    };
    if !matches!(setting, Value::Undefined) {
        let value = if key == "control" || key == "subControl" {
            canonical_control(setting)
        } else {
            materialize_js_value(setting)
        };
        entry.insert(key.into(), value);
    }
    modulator.insert(id_key, Value::Object(entry));
    controls.insert(kind.into(), Value::Object(modulator));
    Value::List(vec![Value::Object(controls), id])
}

/// `install_modulator`: the settings are the members of `config`, in order,
/// after a `control` setting which starts undefined.
fn install(
    receiver: Pattern,
    kind: &'static str,
    config: &Arg,
    id: &Arg,
) -> Result<Pattern, String> {
    let id = reify_bridged(id)?;
    let mut entries: Vec<(String, &Arg)> = vec![("control".to_owned(), &Arg::Undefined)];
    if let Arg::Object(members) = config {
        for (key, value) in members {
            match entries.iter_mut().find(|(name, _)| name == key) {
                Some(current) => current.1 = value,
                None => entries.push((key.clone(), value)),
            }
        }
    }
    let default = Arc::new(Mutex::new(None));
    let mut output = receiver
        .fmap(|value| Value::List(vec![value.clone()]))
        .app_left_with(id, append);
    for (raw_key, value) in entries {
        let key = subcontrol(kind, &raw_key);
        let default = Arc::clone(&default);
        output = output.app_left_with(reify_bridged(value)?, move |pair, setting| {
            apply_setting(pair, setting, kind, &key, &default)
        });
    }
    Ok(output.fmap(|value| match materialize_js_value(value) {
        Value::List(values) => values.first().cloned().unwrap_or(Value::Undefined),
        _ => Value::Undefined,
    }))
}

/// `lfo`, `env` and `bmod`, as a method or a global.
pub fn modulator(call: &Call, kind: &'static str) -> Result<Pattern, String> {
    match call.this {
        Some(receiver) => install(receiver.clone(), kind, call.arg(0), call.arg(1)),
        None => install(
            pure(Value::Object(OrderedMap::new())),
            kind,
            call.arg(0),
            &Arg::Undefined,
        ),
    }
}

/// `modulate(kind, config, id)`: a name of a kind which does not exist leaves
/// the pattern unchanged.
pub fn modulate(call: &Call) -> Result<Pattern, String> {
    let receiver = call.receiver()?;
    let kind = match call.arg(0).as_str() {
        Some("lfo") => "lfo",
        Some("env") => "env",
        Some("bmod") => "bmod",
        _ => return Ok(receiver.clone()),
    };
    install(receiver.clone(), kind, call.arg(1), call.arg(2))
}
