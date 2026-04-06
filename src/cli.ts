#!/usr/bin/env bun

import { PostgresEngine } from './core/postgres-engine.ts';
import { loadConfig, toEngineConfig } from './core/config.ts';
import type { BrainEngine } from './core/engine.ts';

const VERSION = '0.2.0';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(`gbrain ${VERSION}`);
    return;
  }

  if (command === '--tools-json') {
    const { printToolsJson } = await import('./commands/tools-json.ts');
    printToolsJson();
    return;
  }

  // Commands that don't need a database connection
  if (command === 'init') {
    const { runInit } = await import('./commands/init.ts');
    await runInit(args.slice(1));
    return;
  }

  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(args.slice(1));
    return;
  }

  // All other commands need a database connection
  const engine = await connectEngine();

  try {
    switch (command) {
      case 'get': {
        const { runGet } = await import('./commands/get.ts');
        await runGet(engine, args.slice(1));
        break;
      }
      case 'put': {
        const { runPut } = await import('./commands/put.ts');
        await runPut(engine, args.slice(1));
        break;
      }
      case 'list': {
        const { runList } = await import('./commands/list.ts');
        await runList(engine, args.slice(1));
        break;
      }
      case 'search': {
        const { runSearch } = await import('./commands/search.ts');
        await runSearch(engine, args.slice(1));
        break;
      }
      case 'query': {
        const { runQuery } = await import('./commands/query.ts');
        await runQuery(engine, args.slice(1));
        break;
      }
      case 'import': {
        const { runImport } = await import('./commands/import.ts');
        await runImport(engine, args.slice(1));
        break;
      }
      case 'sync': {
        const { runSync } = await import('./commands/sync.ts');
        await runSync(engine, args.slice(1));
        break;
      }
      case 'export': {
        const { runExport } = await import('./commands/export.ts');
        await runExport(engine, args.slice(1));
        break;
      }
      case 'files': {
        const { runFiles } = await import('./commands/files.ts');
        await runFiles(engine, args.slice(1));
        break;
      }
      case 'embed': {
        const { runEmbed } = await import('./commands/embed.ts');
        await runEmbed(engine, args.slice(1));
        break;
      }
      case 'stats': {
        const { runStats } = await import('./commands/stats.ts');
        await runStats(engine);
        break;
      }
      case 'health': {
        const { runHealth } = await import('./commands/health.ts');
        await runHealth(engine);
        break;
      }
      case 'tag': {
        const { runTag } = await import('./commands/tags.ts');
        await runTag(engine, args.slice(1));
        break;
      }
      case 'untag': {
        const { runUntag } = await import('./commands/tags.ts');
        await runUntag(engine, args.slice(1));
        break;
      }
      case 'tags': {
        const { runTags } = await import('./commands/tags.ts');
        await runTags(engine, args.slice(1));
        break;
      }
      case 'link': {
        const { runLink } = await import('./commands/link.ts');
        await runLink(engine, args.slice(1));
        break;
      }
      case 'unlink': {
        const { runUnlink } = await import('./commands/link.ts');
        await runUnlink(engine, args.slice(1));
        break;
      }
      case 'backlinks': {
        const { runBacklinks } = await import('./commands/link.ts');
        await runBacklinks(engine, args.slice(1));
        break;
      }
      case 'graph': {
        const { runGraph } = await import('./commands/link.ts');
        await runGraph(engine, args.slice(1));
        break;
      }
      case 'timeline': {
        const { runTimeline } = await import('./commands/timeline.ts');
        await runTimeline(engine, args.slice(1));
        break;
      }
      case 'timeline-add': {
        const { runTimelineAdd } = await import('./commands/timeline.ts');
        await runTimelineAdd(engine, args.slice(1));
        break;
      }
      case 'delete': {
        const { runDelete } = await import('./commands/delete.ts');
        await runDelete(engine, args.slice(1));
        break;
      }
      case 'history': {
        const { runHistory } = await import('./commands/version.ts');
        await runHistory(engine, args.slice(1));
        break;
      }
      case 'revert': {
        const { runRevert } = await import('./commands/version.ts');
        await runRevert(engine, args.slice(1));
        break;
      }
      case 'config': {
        const { runConfig } = await import('./commands/config.ts');
        await runConfig(engine, args.slice(1));
        break;
      }
      case 'serve': {
        const { runServe } = await import('./commands/serve.ts');
        await runServe(engine);
        break;
      }
      case 'call': {
        const { runCall } = await import('./commands/call.ts');
        await runCall(engine, args.slice(1));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run gbrain --help for usage');
        process.exit(1);
    }
  } finally {
    await engine.disconnect();
  }
}

async function connectEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init --supabase');
    process.exit(1);
  }

  const engine = new PostgresEngine();
  await engine.connect(toEngineConfig(config));
  return engine;
}

function printHelp() {
  console.log(`gbrain ${VERSION} — personal knowledge brain

USAGE
  gbrain <command> [options]

SETUP
  init [--supabase|--url <conn>]     Create brain (guided wizard)
  upgrade                            Self-update

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question>                   Hybrid search (RRF + expansion)

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  export [--dir ./out/]              Export to markdown

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS
  link <from> <to> [--type T]        Create typed link
  unlink <from> <to>                 Remove link
  backlinks <slug>                   Incoming links
  graph <slug> [--depth N]           Traverse link graph

TAGS
  tags <slug>                        List tags
  tag <slug> <tag>                   Add tag
  untag <slug> <tag>                 Remove tag

TIMELINE
  timeline [<slug>]                  View timeline
  timeline-add <slug> <date> <text>  Add timeline entry

ADMIN
  stats                              Brain statistics
  health                             Brain health dashboard
  history <slug>                     Page version history
  revert <slug> <version-id>         Revert to version
  config [get|set] <key> [value]     Brain config
  serve                              MCP server (stdio)
  call <tool> '<json>'               Raw tool invocation
  version                            Version info
  --tools-json                       Tool discovery (JSON)
`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
