import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('install.sh launcher uses explicit install root argument', async () => {
  const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');

  assert.match(script, /SCRIPT_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"/);
  assert.match(script, /local install_root="\$2"/);
  assert.match(script, /exec node "\$install_root\/src\/cli\.js" "\\\$@"/);
  assert.match(script, /if \[ -f "\$SCRIPT_DIR\/package\.json" \] && \[ -d "\$SCRIPT_DIR\/src" \]; then/);
  assert.match(script, /cd "\$SCRIPT_DIR"/);
  assert.match(script, /install_launcher "\$\(find_launcher_dir\)" "\$SCRIPT_DIR"/);
  assert.match(script, /install_launcher "\$\(find_launcher_dir\)" "\$INSTALL_DIR"/);
});
