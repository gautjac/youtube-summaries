# Listener profile — Jac

<!--
  This file is read verbatim by scripts/summarize-queue.cjs and injected
  into the prompt for every "For You" note. The summarizer treats the whole
  file (minus the HTML comments) as context about the listener. Edit
  freely — the more specific you are, the sharper the notes will be.

  HTML comments in this file are stripped before being sent to the model.
-->

## Who I am

I'm Jac — Jacques Gautreau. I live in Atlantic Canada and I split my time
between creative direction (film, video, brand), making music, and building
small software tools for myself and people I know. 

## What I care about right now

- **AI and tools for thought** — especially where LLMs land in real
  creative workflows, what agent-style tools actually let me do, and how
  the economics of the AI industry shake out. I'm less interested in
  hype-cycle takes and more interested in people shipping real things.
- **Craft** — composition, film and music production, taste, and how
  artists develop a durable voice over decades.
- **Deep focus and attention** — I care about doing real work without the
  productivity-theater trappings. Cal Newport-style thinking lands with me.
- **Current events** — Canadian politics, the Trump administration's
  effects on Canada and the world, climate and energy, tech policy.
- **Systems** — how institutions work, why they fail, and how individuals
  can stay honest inside them.
- ✱*I like technologies that inspire and create moments of awe.


## What I already know (so don't over-explain)

- LLM and AI basics — model families, agentic patterns, common tools
  (Claude, Cursor, v0, Figma Make, etc.). Skip the 101.
- Music and film production fundamentals.
- General news context from listening to news podcasts daily.

## What lights me up in a summary

- Specific, concrete ideas I could try or apply tonight.
- Craftspeople talking honestly about their process.
- Surprising connections across unrelated fields.
- Thoughtful contrarianism grounded in evidence, not cheap hot takes.
- A single sharp insight I'll remember in a week.

## What to skip or deprioritize

- Marketing fluff and breathless "X will change everything" framings.
- Hyper-partisan takes that don't teach me anything I don't already know.
- Recaps of information I'd get from any other news podcast.
- Celebrity gossip or pure-personality interviews without substance.

## Projects — for context only, not for name-dropping

<!--
  These are my current works-in-progress. They're listed here ONLY so that
  if an episode is genuinely, specifically about one of these problem
  spaces, you know the language to use.

  DO NOT force references to these projects in For You notes. Clever-sounding
  connections like "this is the inverse of Carmen" or "this maps onto your
  dashboard" are exactly what I don't want. A note grounded in my general
  interests is always better than a forced project tie-in. If you're reaching
  for a project connection, skip it — just don't mention any project.

  Mention a project only when the episode clearly addresses that exact
  problem (e.g. an episode on AI songwriting tools can mention Carmen by
  name; an episode on institutional decay should not).
-->

- an AI-powered daily dashboard I use for myself
- Carmen, an AI-enhanced songwriting tool
- a guitar fretboard trainer
- songs I'm writing for a summer theatre show
- songs I'm writing for a musical staging in 2027
- a possible NFB documentary pitch about AI and artists

## Feedback — training notes for the For You section

<!--
  This section is high-priority guidance from me to future Claude. Treat
  instructions here as directives, not suggestions, and follow them strictly.
  They override other guidance when there's a conflict.

  I edit this section as I read notes. Any format works — bullets, prose,
  short commands, whatever. The more specific the feedback, the better the
  next batch of notes will be.

  Workflow for me:
    1. Read a For You note on the site.
    2. If something feels off, add a line here.
    3. Run: node scripts/regenerate-for-you.cjs --only=<episode-id>
    4. Re-read. Iterate until it lands.
-->

### Core rule: identify connections, don't offer advice or solutions

Your job is to point out how an episode connects to my areas of interest
(including my projects, when genuinely relevant), NOT to propose what I
should do about it. Be a librarian, not a consultant.

**Do:**
- Point out a connection: "this episode is about X, which touches on
  your interest in Y"
- Flag whether it's worth my time or skippable
- Name a specific insight I'd get out of listening

**Do not:**
- Offer advice, directions, or suggestions about my own work
- Tell me what my project "could ask," "could benefit from," "might
  explore," or "could reframe"
- Propose framings, approaches, or creative moves for me to make
- Turn the note into a prescription of what I should do with the idea

**Tells of the advisory mode to avoid:**
- "Your documentary could…" / "Your dashboard could…" / "Carmen could…"
- "What if you…"
- "The sharper question you could ask is…"
- "This might be worth bringing to your…"
- Any sentence that puts me in the driver's seat of applying the
  episode's ideas. I'll make my own creative decisions.

**Example of what NOT to do (episode 127, Plain English "Job Market for
Young People"):** The note correctly identified a structural-blindness
theme, then veered into proposing how my NFB documentary "could ask a
sharper question than most AI stories do." The first half (identifying
the connection) was good. The second half (advising on how to use the
connection in my own work) is exactly the failure mode.

