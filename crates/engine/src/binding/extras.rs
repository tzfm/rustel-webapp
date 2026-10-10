//! The compatibility registrations of the engine runtime: `loopAt`, `fit`,
//! `slice`, `splice`, `scrub`, `plyWith`, `plyForEach`, `chunkInto`. They
//! follow the calling rules of the registry names and join the same list.
//! Source: `install/compat/patterns.rs`.

use rustel_core::ops::PatOps;
use rustel_core::reference::ReferenceEntry;
use rustel_core::register::{CombinatorFn, DeclaredIn, JoinKind, Registration};
use rustel_core::value::FunctionRef;
use rustel_core::{Pattern, Value, native_combinator};
use rustel_fraction::Fraction;
use std::sync::Arc;

/// A body which takes every argument as a pattern, the receiver last.
/// Source: `install_pattern_arguments` (`install/compat/bindings.rs`).
pub type Body = Arc<dyn Fn(&[Pattern]) -> Pattern + Send + Sync>;

/// What a name of the combinator rows calls.
#[derive(Clone)]
pub enum Callable {
    Registered(Box<Registration>),
    Body { arity: usize, body: Body },
}

impl Callable {
    pub fn arity(&self) -> usize {
        match self {
            Callable::Registered(registration) => registration.arity,
            Callable::Body { arity, .. } => *arity,
        }
    }

    pub fn takes_function(&self) -> bool {
        matches!(self, Callable::Registered(registration) if registration.takes_function)
    }

    /// Apply to the leading arguments as patterns and the receiver.
    pub fn call(&self, args: &[Pattern], receiver: Pattern) -> Pattern {
        match self {
            Callable::Registered(registration) => registration.call(args, receiver),
            Callable::Body { body, .. } => {
                let mut all = args.to_vec();
                all.push(receiver);
                body(&all)
            }
        }
    }
}

pub struct Extra {
    pub names: Vec<String>,
    pub callable: Callable,
    /// A free function too. The others are methods only.
    pub global: bool,
}

const BLANK: ReferenceEntry = ReferenceEntry {
    name: "",
    synonyms: &[],
    summary: "",
    description: "",
    params: &[],
    examples: &[],
    tags: &[],
    no_autocomplete: true,
    deprecated: false,
    origin: "rustel",
};

fn fraction(args: &[Value], index: usize) -> Fraction {
    args.get(index)
        .and_then(rustel_core::register::value_to_fraction)
        .unwrap_or(Fraction::ZERO)
}

fn number(args: &[Value], index: usize) -> f64 {
    args.get(index)
        .and_then(|value| rustel_core::util::parse_numeral(value).ok())
        .unwrap_or(f64::NAN)
}

fn function(args: &[Value], index: usize) -> Option<&FunctionRef> {
    args.get(index).and_then(Value::as_function)
}

fn registration(
    names: &[&str],
    arity: usize,
    takes_function: bool,
    func: CombinatorFn,
) -> Registration {
    Registration {
        names: names.iter().map(|name| Arc::from(*name)).collect(),
        reference: BLANK,
        declared_in: DeclaredIn::PatternModule,
        takes_function,
        arity,
        patternify: true,
        preserve_steps: false,
        join: JoinKind::Inner,
        func,
    }
}

pub fn registrations() -> Vec<Extra> {
    let registered = |names: &[&str], arity, takes_function, func, global| Extra {
        names: names.iter().map(|name| (*name).to_owned()).collect(),
        callable: Callable::Registered(Box::new(registration(names, arity, takes_function, func))),
        global,
    };
    let body = |name: &str, arity, body: Body| Extra {
        names: vec![name.to_owned()],
        callable: Callable::Body { arity, body },
        global: true,
    };
    vec![
        registered(
            &["plyWith", "plywith"],
            3,
            true,
            native_combinator!(|args, pat| {
                rustel_core::combinators::ply_with(&pat, fraction(args, 0), function(args, 1))
            }),
            false,
        ),
        registered(
            &["plyForEach", "plyforeach"],
            3,
            true,
            native_combinator!(|args, pat| {
                rustel_core::combinators::ply_for_each(&pat, fraction(args, 0), function(args, 1))
            }),
            false,
        ),
        body(
            "slice",
            3,
            Arc::new(|p| rustel_core::combinators::slice(&p[2], &p[0], &p[1])),
        ),
        body(
            "splice",
            3,
            Arc::new(|p| rustel_core::combinators::slice(&p[2], &p[0], &p[1]).splice()),
        ),
        registered(
            &["loopAt", "loopat"],
            2,
            false,
            native_combinator!(|args, pat| pat.loop_at(fraction(args, 0))),
            true,
        ),
        registered(
            &["fit"],
            1,
            false,
            native_combinator!(|_args, pat| pat.fit()),
            true,
        ),
        body(
            "scrub",
            2,
            Arc::new(|p| rustel_core::combinators::scrub(&p[1], &p[0])),
        ),
        registered(
            &["chunkInto", "chunkinto"],
            3,
            true,
            CombinatorFn::Dynamic(Arc::new(|args, pat| {
                rustel_core::chunk_into(pat, number(args, 0), function(args, 1))
            })),
            true,
        ),
    ]
}
