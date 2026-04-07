import { main } from "./cli/main.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
