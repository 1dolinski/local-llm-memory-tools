import type { Tool } from 'ollama';
import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppState } from './memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Prefer project-local @tobilu/qmd CLI; fall back to `qmd` on PATH (global install). */
function qmdShellPrefix(): string {
  const cli = path.join(__dirname, '..', 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
  if (fs.existsSync(cli)) {
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`;
  }
  return 'qmd';
}
import {
  addTask,
  moveTask,
  removeTask,
  addMemory,
  formatTasks,
} from './memory.js';
import { getDb } from './db.js';
import { addCronJob, listCronJobs, removeCronJob, toggleCronJob } from './cron.js';

export function qmd(cmd: string, timeout = 30_000): string {
  try {
    const shell =
      process.platform === 'win32'
        ? (process.env.ComSpec ?? 'cmd.exe')
        : '/bin/sh';
    return execSync(`${qmdShellPrefix()} ${cmd}`, {
      encoding: 'utf-8',
      timeout,
      shell,
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.stderr || err.message });
  }
}

export const tools: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: 'Add a new task to the task list',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title/description' },
          list: {
            type: 'string',
            enum: ['todo', 'upcoming', 'done'],
            description: 'Which list to add to (default: todo)',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_task',
      description: 'Move a task between lists (todo, upcoming, done)',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID' },
          to: {
            type: 'string',
            enum: ['todo', 'upcoming', 'done'],
            description: 'Target list',
          },
        },
        required: ['task_id', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_task',
      description: 'Remove a task from any list',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to remove' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Show all tasks across todo, upcoming, and done lists',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Save an important fact, preference, or context to long-term memory for future reference across sessions',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_apis',
      description:
        'Search APINow marketplace for available APIs. Returns namespace and endpoint names you can pass directly to call_api.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What kind of API to search for',
          },
          limit: { type: 'number', description: 'Max results (default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_api',
      description:
        'Execute a paid API call on APINow. Provide namespace and endpoint from search results. Payment handled automatically. Example: namespace="acme", endpoint="weather", body={"city":"Paris"}',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'API namespace from search results (e.g. "gg402")',
          },
          endpoint: {
            type: 'string',
            description: 'Endpoint name from search results (e.g. "weather", "translate")',
          },
          body: {
            type: 'object',
            description: 'Request body with the required parameters',
          },
        },
        required: ['namespace', 'endpoint'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_tool',
      description:
        'When you need an API/tool that is not available, suggest it and optionally search APINow for matches',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'What tool/API would be useful and why',
          },
          search_query: {
            type: 'string',
            description: 'Optional query to search APINow for matching tools',
          },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_search',
      description:
        'Fast BM25 keyword search across indexed documents using QMD. Best for exact keyword matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          collection: {
            type: 'string',
            description: 'Restrict to a specific collection (optional)',
          },
          num_results: {
            type: 'number',
            description: 'Number of results (default 5)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_query',
      description:
        'Hybrid deep search using QMD: BM25 + vector search + query expansion + LLM reranking. Best quality, slower.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          collection: {
            type: 'string',
            description: 'Restrict to a specific collection (optional)',
          },
          num_results: {
            type: 'number',
            description: 'Number of results (default 5)',
          },
          min_score: {
            type: 'number',
            description: 'Minimum relevance score 0-1 (default 0)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_get',
      description:
        'Retrieve a specific document from QMD by file path or docid (e.g. #abc123)',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path or docid (e.g. "notes/meeting.md" or "#abc123")',
          },
          full: {
            type: 'boolean',
            description: 'Return full document content (default true)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_status',
      description:
        'Check QMD index health: collections, document count, embedding status',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_collection_add',
      description:
        'Index a directory of markdown files as a QMD collection. After adding, you MUST call qmd_embed to generate vector embeddings, then qmd_context_add to describe the collection.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to index',
          },
          name: {
            type: 'string',
            description: 'Collection name',
          },
          mask: {
            type: 'string',
            description: 'Glob pattern for files (default: **/*.md)',
          },
        },
        required: ['path', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_collection_list',
      description: 'List all QMD collections and their paths',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_collection_remove',
      description: 'Remove a QMD collection by name',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Collection name to remove' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_embed',
      description:
        'Generate vector embeddings for all indexed QMD documents. Required after adding/updating collections to enable semantic search (qmd_query). Downloads models on first run (~2GB).',
      parameters: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Force re-embed everything (default false)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_update',
      description:
        'Re-index all QMD collections to pick up new/changed files. Run this when documents have been modified.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_context_add',
      description:
        'Add a context description to a QMD collection or path. Context helps search understand content and is returned with results. Use qmd:// virtual paths (e.g. qmd://notes, qmd://docs/api).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Virtual path (e.g. "qmd://notes" or "qmd://docs/api")',
          },
          description: {
            type: 'string',
            description: 'Human description of what this collection/path contains',
          },
        },
        required: ['path', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qmd_context_list',
      description: 'List all context descriptions set on QMD collections',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_cron',
      description:
        'Schedule a recurring task. The prompt runs automatically on the cron schedule. Example: expression="0 8 * * *" (daily 8am), prompt="what is on my task list today"',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Cron expression (e.g. "0 8 * * *" for daily at 8am, "*/30 * * * *" for every 30 min)',
          },
          prompt: {
            type: 'string',
            description: 'The message/prompt to run on each tick',
          },
          description: {
            type: 'string',
            description: 'Short label for this job (optional)',
          },
        },
        required: ['expression', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_crons',
      description: 'List all scheduled cron jobs with their status, schedule, and last run time',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_cron',
      description: 'Delete a cron job by its ID',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Cron job ID' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_cron',
      description: 'Enable or disable a cron job by its ID (toggles current state)',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Cron job ID' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_db',
      description:
        'Run a read-only SQL query against the app database (SQLite). Only SELECT is allowed. Tables: cron_jobs (id, expression, prompt, description, enabled, last_run, created_at), telegram_state (chat_id, last_message_id, created_at).',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'SQL SELECT query',
          },
        },
        required: ['sql'],
      },
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, any>,
  state: AppState,
  apinow: any
): Promise<string> {
  try {
    switch (name) {
      case 'add_task': {
        const task = addTask(state, args.title, args.list || 'todo');
        return JSON.stringify({
          ok: true,
          task,
          message: `Added "${task.title}" to ${args.list || 'todo'}`,
        });
      }
      case 'move_task': {
        const msg = moveTask(state, args.task_id, args.to);
        return JSON.stringify({ ok: true, message: msg });
      }
      case 'remove_task': {
        const msg = removeTask(state, args.task_id);
        return JSON.stringify({ ok: true, message: msg });
      }
      case 'list_tasks': {
        return formatTasks(state);
      }
      case 'save_memory': {
        addMemory(state, args.content);
        return JSON.stringify({ ok: true, message: 'Saved to memory' });
      }
      case 'search_apis': {
        const results = await apinow.search(args.query, args.limit || 5);
        return JSON.stringify(results);
      }
      case 'call_api': {
        const url = `https://www.apinow.fun/api/endpoints/${args.namespace}/${args.endpoint}`;
        const result = await apinow.call(url, {
          method: 'POST',
          body: args.body || {},
        });
        return JSON.stringify(result);
      }
      case 'suggest_tool': {
        let msg = `Tool suggestion: ${args.description}`;
        if (args.search_query) {
          try {
            const results = await apinow.search(args.search_query, 3);
            msg += `\n\nFound on APINow:\n${JSON.stringify(results, null, 2)}`;
          } catch {
            msg += '\n\n(Could not search APINow for matching tools)';
          }
        }
        return msg;
      }
      case 'qmd_search': {
        const n = args.num_results || 5;
        const col = args.collection ? ` -c ${args.collection}` : '';
        return qmd(`search --json -n ${n}${col} ${JSON.stringify(args.query)}`);
      }
      case 'qmd_query': {
        const n = args.num_results || 5;
        const col = args.collection ? ` -c ${args.collection}` : '';
        const ms = args.min_score ? ` --min-score ${args.min_score}` : '';
        return qmd(`query --json -n ${n}${col}${ms} ${JSON.stringify(args.query)}`);
      }
      case 'qmd_get': {
        const full = args.full !== false ? ' --full' : '';
        return qmd(`get${full} ${JSON.stringify(args.path)}`);
      }
      case 'qmd_status': {
        return qmd('status');
      }
      case 'qmd_collection_add': {
        const mask = args.mask ? ` --mask ${JSON.stringify(args.mask)}` : '';
        return qmd(`collection add ${JSON.stringify(args.path)} --name ${args.name}${mask}`);
      }
      case 'qmd_collection_list': {
        return qmd('collection list');
      }
      case 'qmd_collection_remove': {
        return qmd(`collection remove ${args.name}`);
      }
      case 'qmd_embed': {
        const force = args.force ? ' -f' : '';
        return qmd(`embed${force}`, 300_000);
      }
      case 'qmd_update': {
        return qmd('update', 60_000);
      }
      case 'qmd_context_add': {
        return qmd(`context add ${args.path} ${JSON.stringify(args.description)}`);
      }
      case 'qmd_context_list': {
        return qmd('context list');
      }
      case 'add_cron': {
        const job = addCronJob(args.expression, args.prompt, args.description || '');
        return JSON.stringify({ ok: true, job, message: `Cron job #${job.id} created: "${job.expression}"` });
      }
      case 'list_crons': {
        const jobs = listCronJobs();
        if (jobs.length === 0) return JSON.stringify({ jobs: [], message: 'No cron jobs scheduled' });
        return JSON.stringify({ jobs });
      }
      case 'remove_cron': {
        const removed = removeCronJob(args.id);
        return JSON.stringify({ ok: removed, message: removed ? `Cron job #${args.id} removed` : `Cron job #${args.id} not found` });
      }
      case 'toggle_cron': {
        const job = toggleCronJob(args.id);
        if (!job) return JSON.stringify({ ok: false, message: `Cron job #${args.id} not found` });
        return JSON.stringify({ ok: true, job, message: `Cron job #${args.id} is now ${job.enabled ? 'enabled' : 'disabled'}` });
      }
      case 'query_db': {
        const sql = (args.sql as string).trim();
        if (!/^\s*SELECT\b/i.test(sql)) {
          return JSON.stringify({ error: 'Only SELECT queries are allowed' });
        }
        try {
          const rows = getDb().prepare(sql).all();
          return JSON.stringify({ rows, count: rows.length });
        } catch (err: any) {
          return JSON.stringify({ error: err.message });
        }
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: err.message || String(err) });
  }
}
