/**
 * Module-resolution hooks that point the bare specifier `pg` at `pg-tap.mjs`.
 *
 * Registered with `module.register()` by the script that wants the tap; every
 * other specifier is handed straight on to the next resolver, so tsx's own
 * TypeScript hooks keep working underneath.
 */
const TAP = new URL("./pg-tap.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pg") return { url: TAP, format: "module", shortCircuit: true };
  return nextResolve(specifier, context);
}
