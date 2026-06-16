import { hello } from "./mod.ts";

if (import.meta.main) {
  console.log(hello());
}
