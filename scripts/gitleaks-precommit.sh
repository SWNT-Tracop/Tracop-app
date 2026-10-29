#!/usr/bin/env sh
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact
else
  printf '%s\n' 'gitleaks is not installed locally; PR scanning remains enabled.'
fi
