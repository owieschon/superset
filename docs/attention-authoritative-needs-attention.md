# Attention is authoritative: page humans for Needs attention

Pair with [proof-gate-needs-review-receipt.md](./proof-gate-needs-review-receipt.md).

**Needs attention** on the board (and matching CLI/status surfaces that already
speak board nouns) is the signal that a human should look. Do not invent a second
paging channel, a parallel detector, or a new status vocabulary beside the
attested columns: Needs attention / Needs review / working / failed / idle.

## Operator rule

1. Treat **Needs attention** as the authoritative "page a human" signal.
2. Do not invent a separate NeedsHuman product state or column.
3. Do not stand up a second `agentStatus` source of truth — leave CLI/SDK
   status ownership to the in-flight work that already owns it.
4. Failed work that still chimes as success is a lying-about-done bug (see OS
   notification honesty); fixing copy is not a new attention system.

## Tip-native proof before changing attention chrome

Same bar as the Needs review proof gate: tip SHA, focused proof or fork CI at
that SHA, receipt, cite under **How I tested it**, stay draft until proof exists.

## What this is not

- Not a wake-policy / Attention Contract redesign.
- Not dock badge ownership.
- Not a new board column.
