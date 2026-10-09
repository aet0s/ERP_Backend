const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '../routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

for (const file of files) {
  const content = fs.readFileSync(path.join(routesDir, file), 'utf8');
  const lines = content.split('\n');
  const missingPerm = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/router\.(get|post|put|delete|patch)\s*\(/)) {
      if (line.includes('requireAuth') && !line.includes('requirePermission') && !line.includes('requireRole') && !line.includes('requirePlatformAdminAuth')) {
        // Exclude /me, /logout, /health, etc.
        missingPerm.push({ lineNum: i + 1, code: line.trim() });
      }
    }
  }

  if (missingPerm.length > 0) {
    console.log(`\n=== ${file} (${missingPerm.length} routes missing permission check) ===`);
    missingPerm.slice(0, 15).forEach(m => console.log(`  L${m.lineNum}: ${m.code}`));
  }
}
