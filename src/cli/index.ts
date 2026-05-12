import { Command } from "commander";

export function main(argv: string[]): void {
  const program = new Command();

  program
    .name("rogue-one")
    .description("Headless SDLC workflow engine — Claude Code worker for yavin-iv.")
    .version("0.0.1");

  program
    .command("start")
    .description("Create a new run via yavin-iv REST API (short-lived; slash command entrypoint).")
    .argument("<instructions>", "Free-form instructions for the run")
    .argument("<ticketUrl>", "URL of the ticket (Jira / Linear / GitHub Issue)")
    .action((_instructions, _ticketUrl) => {
      console.error("rogue-one start: not implemented yet (task 06).");
      process.exit(1);
    });

  program
    .command("worker")
    .description("Run the long-lived worker process (connects to yavin-iv, claims runs).")
    .action(() => {
      console.error("rogue-one worker: not implemented yet (task 05).");
      process.exit(1);
    });

  program.parse(["node", "rogue-one", ...argv]);
}
