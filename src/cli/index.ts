import { Command } from "commander";
import { TICKET_PROVIDERS, type TicketProvider } from "../protocol.js";
import { YavinApiError, YavinClient } from "../yavin/client.js";
import { startWorker } from "../worker/index.js";

export interface CliDeps {
  /** Factory for YavinClient (tests inject a fetch). */
  createClient?: () => YavinClient;
  /** Worker entrypoint (tests stub it). */
  startWorker?: typeof startWorker;
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<void> {
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
    .option("--repo-config-id <id>", "Repo config UUID in yavin-iv")
    .option("--ticket-provider <provider>", "Ticket provider", "jira")
    .action(async (instructions: string, ticketUrl: string, options: StartOptions) => {
      const code = await runStart(instructions, ticketUrl, options, deps);
      if (code !== 0) process.exit(code);
    });

  program
    .command("worker")
    .description("Run the long-lived worker process (connects to yavin-iv, claims runs).")
    .action(async () => {
      const code = await runWorker(deps);
      if (code !== 0) process.exit(code);
    });

  await program.parseAsync(["node", "rogue-one", ...argv]);
}

interface StartOptions {
  repoConfigId?: string;
  ticketProvider?: string;
}

async function runStart(
  instructions: string,
  ticketUrl: string,
  options: StartOptions,
  deps: CliDeps,
): Promise<number> {
  if (!options.repoConfigId) {
    console.error(
      "rogue-one start: --repo-config-id is required (auto-detection lands in a later task).",
    );
    return 1;
  }
  const ticketProvider = options.ticketProvider ?? "jira";
  if (!(TICKET_PROVIDERS as readonly string[]).includes(ticketProvider)) {
    console.error(
      `rogue-one start: --ticket-provider must be one of ${TICKET_PROVIDERS.join(", ")} (got "${ticketProvider}").`,
    );
    return 1;
  }

  let ticketId: string;
  try {
    ticketId = deriveTicketId(ticketUrl);
  } catch (err) {
    console.error(
      `rogue-one start: invalid ticket URL "${ticketUrl}": ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }

  let client: YavinClient;
  try {
    client = deps.createClient ? deps.createClient() : new YavinClient();
  } catch (err) {
    console.error(`rogue-one start: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  try {
    const { run } = await client.createRun({
      repoConfigId: options.repoConfigId,
      ticketProvider: ticketProvider as TicketProvider,
      ticketId,
      ticketUrl,
      instructions,
    });
    const baseUrl =
      process.env.YAVIN_URL ?? process.env.YAVIN_BASE_URL ?? "";
    const trimmed = baseUrl.replace(/\/+$/, "");
    console.log(`Run created: ${trimmed}/runs/${run.id}`);
    console.log(`Status: ${run.status}`);
    return 0;
  } catch (err) {
    if (err instanceof YavinApiError) {
      console.error(`rogue-one start: HTTP ${err.status} — ${summarizeBody(err.body)}`);
    } else {
      console.error(`rogue-one start: ${err instanceof Error ? err.message : err}`);
    }
    return 1;
  }
}

async function runWorker(deps: CliDeps): Promise<number> {
  try {
    const start = deps.startWorker ?? startWorker;
    await start();
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export function deriveTicketId(ticketUrl: string): string {
  const parsed = new URL(ticketUrl);
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return ticketUrl;
  return last;
}

function summarizeBody(body: unknown): string {
  if (body == null) return "(empty body)";
  if (typeof body === "string") return body.slice(0, 500);
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body).slice(0, 500);
  }
}
