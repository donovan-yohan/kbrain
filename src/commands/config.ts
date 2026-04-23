import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, getBrainIdentity } from '../core/config.ts';

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];
  const key = args[1];
  const value = args[2];

  if (action === 'show') {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: gbrain init');
      process.exit(1);
    }
    const wantsJson = args.includes('--json');
    const brainIdentity = getBrainIdentity(config);
    if (wantsJson) {
      const redactedConfig = Object.fromEntries(
        Object.entries(config).map(([k, v]) => {
          if (typeof v === 'string' && v.includes('postgresql://')) {
            return [k, redactUrl(v)];
          }
          if (typeof v === 'string' && (k.includes('key') || k.includes('secret'))) {
            return [k, '***'];
          }
          return [k, v];
        }),
      );
      console.log(JSON.stringify({ config: redactedConfig, brain_identity: brainIdentity }, null, 2));
      return;
    }
    console.log('GBrain config:');
    for (const [k, v] of Object.entries(config)) {
      const display = typeof v === 'string' && v.includes('postgresql://')
        ? redactUrl(v)
        : typeof v === 'string' && (k.includes('key') || k.includes('secret'))
          ? '***'
          : v;
      console.log(`  ${k}: ${display}`);
    }
    if (brainIdentity) {
      console.log('  brain_identity: ' + JSON.stringify(brainIdentity));
    }
    return;
  }

  if (action === 'get' && key) {
    const val = await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    await engine.setConfig(key, value);
    console.log(`Set ${key} = ${value}`);
  } else {
    console.error('Usage: gbrain config [show|get|set] <key> [value]');
    process.exit(1);
  }
}
