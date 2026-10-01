import { appendFileSync, readFileSync } from 'node:fs';

const selectedPlatform = process.argv[2];
const outputPath = process.env.GITHUB_OUTPUT;

export function selectedBuildIds(builds, platform) {
  const platforms = platform === 'all' ? ['ios', 'android'] : [platform];
  if (!Array.isArray(builds)) throw new Error('EAS build output must be a JSON array.');
  if (platforms.length === 0 || platforms.some((value) => !['ios', 'android'].includes(value))) {
    throw new Error('Platform must be ios, android, or all.');
  }

  const ids = {};
  for (const value of platforms) {
    const matching = builds.filter((build) => String(build?.platform ?? '').toLowerCase() === value);
    if (matching.length !== 1) {
      throw new Error(`Expected exactly one ${value} build from this EAS run; received ${matching.length}.`);
    }
    const [build] = matching;
    if (typeof build.id !== 'string' || !/^[0-9a-f-]{16,}$/i.test(build.id)) {
      throw new Error(`EAS did not return a valid ${value} build ID.`);
    }
    if (String(build.status ?? '').toUpperCase() !== 'FINISHED') {
      throw new Error(`The ${value} EAS build is not finished (status: ${String(build.status ?? 'missing')}).`);
    }
    ids[value] = build.id;
  }
  return ids;
}

if (process.argv[1]?.endsWith('record-store-builds.mjs')) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required to record EAS build IDs.');
  const jsonPath = process.argv[3];
  if (!jsonPath) throw new Error('Usage: npm run record:store-builds -- <platform> <eas-build-json>');
  const builds = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const ids = selectedBuildIds(builds, selectedPlatform);
  for (const [platform, id] of Object.entries(ids)) appendFileSync(outputPath, `${platform}_build_id=${id}\n`);
  console.log(`Recorded exact completed EAS build ID(s) for ${Object.keys(ids).join(', ')}.`);
}
