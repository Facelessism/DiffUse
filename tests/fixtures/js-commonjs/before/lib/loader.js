async function load(name) {
  const dynamic = await import("./math.js");
  const computed = require("./" + name);
  return [dynamic, computed];
}

module.exports = { load };
