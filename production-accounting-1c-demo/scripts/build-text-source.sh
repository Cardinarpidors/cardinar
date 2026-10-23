#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_file="$project_dir/Cardinar-source-code.txt"

files=(
  "project.yml"
  "README.md"
  "SCENARIO.md"
  "index.html"
  "ai-overview.html"
  "llms.txt"
  "app.js"
  "data.js"
  "styles.css"
  "favicon.svg"
  "assets/cardinar-logo.svg"
  "tests/smoke.js"
  "bump.sh"
)

{
  printf 'CARDINAR - ИСХОДНЫЙ КОД ДЕМО-ПРОЕКТА\n'
  printf 'Формат: единый текстовый документ для передачи другой ИИ-системе.\n'
  printf 'Проект: production-accounting-1c-demo\n'
  printf 'Состав: HTML, CSS, JavaScript, SVG, документация и smoke-тест.\n'
  printf 'Важно: бинарные PNG-файлы не включены. Их исходный векторный вариант включен как SVG.\n'
  printf 'Для восстановления проекта разделите содержимое по маркерам FILE BEGIN / FILE END.\n'
  printf '\n'

  for relative_path in "${files[@]}"; do
    source_path="$project_dir/$relative_path"
    if [[ ! -f "$source_path" ]]; then
      printf 'WARNING: отсутствует файл %s\n\n' "$relative_path"
      continue
    fi

    printf '%s\n' '================================================================================'
    printf 'FILE BEGIN: %s\n' "$relative_path"
    printf '%s\n' '================================================================================'
    sed 's/\r$//' "$source_path"
    printf '\n'
    printf '%s\n' '================================================================================'
    printf 'FILE END: %s\n' "$relative_path"
    printf '%s\n\n' '================================================================================'
  done
} > "$output_file"

printf '%s\n' "$output_file"
