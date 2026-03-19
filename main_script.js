/**
 * Blind Skill Rolls - PF1e
 *
 * How it works:
 *  1. We hook into PF1e's skill roll process BEFORE the roll happens.
 *  2. We force the roll to be "blind" so Foundry itself doesn't broadcast it.
 *  3. We listen AFTER the roll completes and re-send the result as a
 *     GM-only whisper, plus a public "blind roll" notice to the player.
 */

// ──────────────────────────────────────────────────────────────────────────────
// 1. MODULE SETTINGS
//    Lets the GM toggle the feature on/off from Module Settings in-game.
// ──────────────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register("blind-skill-rolls-pf1e", "enabled", {
    name: "Enable Blind Skill Rolls",
    hint: "When enabled, skill roll results are only visible to the GM. Players see a notice that a roll occurred.",
    scope: "world",       // GM-controlled, saved for everyone
    config: true,         // Show in Module Settings UI
    type: Boolean,
    default: true,
  });

  console.log("Blind Skill Rolls (PF1e) | Initialized");
});


// ──────────────────────────────────────────────────────────────────────────────
// 2. INTERCEPT THE ROLL — pf1PreActorRollSkill
//    This hook fires BEFORE the dice are rolled.
//    Returning `false` from this hook would cancel the roll entirely —
//    we do NOT want that. Instead we just set a flag so we know to
//    intercept the resulting chat message.
//
//    Hook signature (from PF1e source):
//      pf1PreActorRollSkill(actor, rollData, skillId)
//      - actor    : the Actor doing the roll
//      - rollData : options/config object for the roll (we can mutate this)
//      - skillId  : string like "per" (Perception), "ste" (Stealth), etc.
// ──────────────────────────────────────────────────────────────────────────────

Hooks.on("pf1PreActorRollSkill", (actor, rollData, skillId) => {
  if (!game.settings.get("blind-skill-rolls-pf1e", "enabled")) return;

  // Mark the roll as "blind" in PF1e's roll options.
  // This tells the system to suppress the normal chat output.
  rollData.skipDialog = true;   // skip the roll dialog if any
  rollData.chatMessage = false; // tell PF1e NOT to post the chat card itself

  // Store the skill name nicely so we can use it in our custom messages.
  // PF1e stores skill labels in the actor's system data.
  const skillName = _getSkillName(actor, skillId);

  // Tag the rollData so our post-roll hook can identify this as a blind roll.
  rollData._blindSkillRoll = true;
  rollData._blindSkillName = skillName;
  rollData._blindActorName = actor.name;
  rollData._blindActorId   = actor.id;
});


// ──────────────────────────────────────────────────────────────────────────────
// 3. AFTER THE ROLL — pf1ActorRollSkill
//    This hook fires AFTER the roll is resolved and we have a result.
//
//    Hook signature:
//      pf1ActorRollSkill(actor, roll, skillId)
//      - actor   : the Actor
//      - roll    : the completed Roll object (has .total, .formula, etc.)
//      - skillId : string skill key
// ──────────────────────────────────────────────────────────────────────────────

Hooks.on("pf1ActorRollSkill", (actor, roll, skillId) => {
  if (!game.settings.get("blind-skill-rolls-pf1e", "enabled")) return;

  const skillName = _getSkillName(actor, skillId);

  // ── 3a. Send full result ONLY to the GM(s) ──
  const gmUserIds = game.users
    .filter(u => u.isGM)
    .map(u => u.id);

  ChatMessage.create({
    content: `
      <div class="pf1 chat-card">
        <header class="card-header flexrow">
          <img src="${actor.img}" title="${actor.name}" width="36" height="36"/>
          <h3>${actor.name} — ${skillName} (Blind Roll)</h3>
        </header>
        <div class="card-content">
          <p><strong>Result:</strong> ${roll.total}</p>
          <p><strong>Formula:</strong> <em>${roll.formula}</em></p>
          ${roll.terms ? `<p><strong>Dice:</strong> ${_formatDice(roll)}</p>` : ""}
        </div>
      </div>
    `,
    whisper: gmUserIds,    // only GMs see this message
    speaker: ChatMessage.getSpeaker({ actor }),
    type: CONST.CHAT_MESSAGE_TYPES.ROLL,
    roll: roll,            // attach the actual Roll so dice tooltips work
    rollMode: "gmroll",
    flavor: `${skillName} Check (Blind)`,
  });

  // ── 3b. Send a PUBLIC notice to everyone so the player knows a roll happened ──
  //    We deliberately do NOT include the number.
  ChatMessage.create({
    content: `
      <div class="pf1 chat-card">
        <header class="card-header flexrow">
          <img src="${actor.img}" title="${actor.name}" width="36" height="36"/>
          <h3>${actor.name} — ${skillName}</h3>
        </header>
        <div class="card-content">
          <p><em>A blind skill roll was made. The result is known only to the GM.</em></p>
        </div>
      </div>
    `,
    speaker: ChatMessage.getSpeaker({ actor }),
    type: CONST.CHAT_MESSAGE_TYPES.OTHER,
  });
});


// ──────────────────────────────────────────────────────────────────────────────
// 4. HELPER FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Gets a human-readable skill name from the actor and skill ID.
 * PF1e skills live at actor.system.skills[skillId].
 * Sub-skills (like Perform subcategories) are nested one level deeper.
 */
function _getSkillName(actor, skillId) {
  // skillId can be a simple key like "per" or a compound like "art.dance"
  // for sub-skills (e.g. Artistry, Perform, Craft subcategories).
  const parts = skillId.split(".");
  const skills = actor.system?.skills;

  if (!skills) return skillId; // fallback: just show the raw key

  const topSkill = skills[parts[0]];
  if (!topSkill) return skillId;

  if (parts.length === 1) {
    // Simple skill — PF1e uses a `name` property OR we fall back to the key.
    return topSkill.name ?? _prettifyKey(parts[0]);
  }

  // Sub-skill: e.g. skills["art"]["subSkills"]["dance"]
  const subSkill = topSkill.subSkills?.[parts[1]];
  const parentName = topSkill.name ?? _prettifyKey(parts[0]);
  const subName    = subSkill?.name ?? _prettifyKey(parts[1]);
  return `${parentName} (${subName})`;
}

/**
 * Converts a camelCase or short key into a readable label.
 * e.g. "ste" → "Ste",  "sleightOfHand" → "Sleight Of Hand"
 * PF1e usually gives us a proper .name so this is just a fallback.
 */
function _prettifyKey(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, str => str.toUpperCase());
}

/**
 * Formats the individual dice results into a readable string.
 * e.g. "1d20: [14] + 7"
 */
function _formatDice(roll) {
  return roll.terms
    .map(term => {
      if (term.results) {
        // It's a dice term
        const faces  = term.faces;
        const rolled = term.results.map(r => r.result).join(", ");
        return `d${faces}[${rolled}]`;
      }
      // It's a number/operator term
      return term.expression ?? String(term.total ?? "");
    })
    .join(" ");
}
