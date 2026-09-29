import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { preparePlannerData } from '../src/csv-import.js';

try {
  const [sourcePath, enrichmentPath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !enrichmentPath || !outputPath) throw new Error('Использование: node scripts/prepare-data.js source.json enrichment.json output.json');
  if ([sourcePath, enrichmentPath].some(p => resolve(p).toLowerCase() === resolve(outputPath).toLowerCase())) throw new Error('Результат должен отличаться от исходного JSON и шаблона.');
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  const enrichment = JSON.parse(await readFile(enrichmentPath, 'utf8'));
  const result = preparePlannerData(source, enrichment);
  if (!result.ready) {
    console.error(`JSON не готов к планированию. Проблем: ${result.issues.length}. Существующий файл результата не изменён.`);
    result.issues.slice(0, 12).forEach(issue => console.error(`${issue.requestId ?? 'Набор'}: ${issue.message}`));
    if (result.issues.length > 12) console.error(`Ещё ${result.issues.length - 12} проблем. Полный список доступен через preparePlannerData().issues.`);
    process.exitCode = 2;
  } else {
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, JSON.stringify(result.data, null, 2) + '\n', 'utf8');
    console.log(`Готово: ${result.data.requests.length} заявок, ${result.data.engineers.length} инженеров. ${resolve(outputPath)}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
