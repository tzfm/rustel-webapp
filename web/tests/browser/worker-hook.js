// Test hook for the `recovery` session. The test server puts this text in front
// of worker.js, so the product bundle stays as built and the hook exists in the
// test only. No score makes the engine module trap or kills a Worker, so two
// scores with a comment for text ask the hook:
//
//   // test:trap    the next engine turn throws a trap
//   // test:death   the Worker throws out of its message listener, which fires
//                   the error event of the Worker. The glue never sees the message.
//
// The hook runs before the glue and before the lockdown. The lockdown removes
// the global names later, so the hook takes the names the hook needs first.
{
  const Wasm = WebAssembly;
  const instantiate = Wasm.instantiate;
  let armed = false;
  Wasm.instantiate = async (...args) => {
    const result = await instantiate.apply(Wasm, args);
    if (!(result instanceof Wasm.Instance)) return result;
    // The exports of an instance are frozen, so the hook hands out a copy.
    const exports = { ...result.exports };
    const turn = exports.engine_turn;
    if (turn) {
      exports.engine_turn = (...turnArgs) => {
        if (armed) {
          armed = false;
          throw new Wasm.RuntimeError("test trap");
        }
        return turn(...turnArgs);
      };
    }
    return { exports };
  };
  addEventListener("message", (event) => {
    const { type, text } = event.data ?? {};
    if (type !== "set" && type !== "play") return;
    if (text === "// test:trap") armed = true;
    if (text === "// test:death") {
      event.stopImmediatePropagation();
      throw new Error("test death");
    }
  });
}
