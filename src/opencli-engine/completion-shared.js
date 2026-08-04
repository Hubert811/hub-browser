/**
 * Shared constants and shell script generators for tab-completion.
 *
 * This module MUST remain lightweight (no registry, no discovery imports).
 * Both completion.ts (full path) and completion-fast.ts (manifest path) import from here.
 */
/**
 * Built-in (non-dynamic) top-level commands.
 */
export const BUILTIN_COMMANDS = [
    'list',
    'validate',
    'verify',
    'auth',
    'browser',
    'tab',
    'doctor',
    'plugin',
    'external',
    'completion',
];
// ── Shell script generators ────────────────────────────────────────────────
export function bashCompletionScript() {
    return `# Bash completion for hub
# Add to ~/.bashrc:  eval "$(hub completion bash)"
_hub_completions() {
  local cur words cword
  _get_comp_words_by_ref -n : cur words cword

  local completions
  completions=$(hub --get-completions --cursor "$cword" "\${words[@]:1}" 2>/dev/null)

  COMPREPLY=( $(compgen -W "$completions" -- "$cur") )
  __ltrim_colon_completions "$cur"
}
complete -F _hub_completions hub
`;
}
export function zshCompletionScript() {
    return `# Zsh completion for hub
# Add to ~/.zshrc:  eval "$(hub completion zsh)"
_hub() {
  local -a completions
  local cword=$((CURRENT - 1))
  completions=(\${(f)"$(hub --get-completions --cursor "$cword" "\${words[@]:1}" 2>/dev/null)"})
  compadd -a completions
}
compdef _hub hub
`;
}
export function fishCompletionScript() {
    return `# Fish completion for hub
# Add to ~/.config/fish/config.fish:  hub completion fish | source
complete -c hub -f -a '(
  set -l tokens (commandline -cop)
  set -l cursor (count (commandline -cop))
  hub --get-completions --cursor $cursor $tokens[2..] 2>/dev/null
)'
`;
}
