import type { ConversationTurn } from "@cursor-gateway/shared";

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARACTERS = 48_000;

export function truncateConversationHistory(history: ConversationTurn[]): ConversationTurn[] {
  const selected: ConversationTurn[] = [];
  let characters = 0;

  for (let index = history.length - 1; index >= 0 && selected.length < MAX_HISTORY_TURNS; index -= 1) {
    const turn = history[index];
    if (!turn) continue;
    const turnCharacters = turn.prompt.length + turn.response.length;
    if (selected.length > 0 && characters + turnCharacters > MAX_HISTORY_CHARACTERS) break;

    const remaining = MAX_HISTORY_CHARACTERS - characters;
    selected.push(
      turnCharacters <= remaining
        ? turn
        : {
            prompt: turn.prompt.slice(0, Math.min(turn.prompt.length, remaining)),
            response: turn.response.slice(0, Math.max(0, remaining - turn.prompt.length))
          }
    );
    characters += Math.min(turnCharacters, remaining);
  }

  return selected.reverse();
}
