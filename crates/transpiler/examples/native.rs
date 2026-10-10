//! Transpiles every score of a folder with the native transpiler and writes
//! one JSON line per score, for `scripts/transpiler-check.mjs` to compare with
//! the wasm module.
//!
//!     cargo run --example native -p rustel-web-transpiler -- <folder> <records>
//!
//! The folder holds `.strudel` files, in any depth. A line is
//! `{"name":..,"line_map":[[line, column, source_line, source_column],..],"result":{..}}`.
//! The name is the path in the folder without the extension. The result is the
//! text of `wire::encode`, last on the line.
//!
//! This is an example and not a binary. Cargo builds an example on request, so
//! the wasm build and the page never see the file, and clippy still checks the
//! file.
//!
//! The native side calls `transpile` with its own parse thread. The module
//! calls the same entry inside `on_caller_stack`, so a difference in the
//! records shows a difference between the two ways to parse.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use rustel_web_transpiler::wire;

fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut paths = fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect(&path, files)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "strudel")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [folder, records] = args.as_slice() else {
        eprintln!("usage: native <folder> <records>");
        std::process::exit(2);
    };
    let root = Path::new(folder);
    let mut files = Vec::new();
    collect(root, &mut files)?;
    let mut out = io::BufWriter::new(fs::File::create(records)?);
    for path in &files {
        let name = path
            .strip_prefix(root)
            .map_err(io::Error::other)?
            .with_extension("")
            .to_string_lossy()
            .replace('\\', "/");
        let result = wire::run(&fs::read_to_string(path)?);
        let mut line = String::from("{\"name\":");
        wire::string(&mut line, &name);
        line.push_str(",\"line_map\":[");
        for (index, run) in wire::line_map_runs(&result.output.line_map, &result.output.output)
            .iter()
            .enumerate()
        {
            if index > 0 {
                line.push(',');
            }
            let _ = write!(line, "[{},{},{},{}]", run[0], run[1], run[2], run[3]);
        }
        let _ = writeln!(line, "],\"result\":{}}}", wire::encode(&result));
        out.write_all(line.as_bytes())?;
    }
    out.flush()
}
