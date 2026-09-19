const SAMPLES = [
  ["Extraction", "Extract every email address from this block:\nAlice <a@x.com>, Bob bob@y.org, not-an-email"],
  ["Quick question", "What's the capital of France?"],
  ["Hard proof", "Prove that there are infinitely many primes congruent to 3 mod 4.\nBe rigorous."],
  ["Medical dose", "A 12 kg child needs paracetamol. What is a typical single oral dose range in mg, and what must not be exceeded in 24 hours?"],
  ["Long log", "Summarise this 400-line CI log into the first failing test, the likely cause, and the smallest next check. Keep it short."],
  ["Follow-up", "thanks!"],
  ["Essay", "Write a 1200-word explainer of prompt caching for software engineers. No extra reasoning beyond a clean outline."],
];

const history = [];
const thread = document.getElementById("thread");
const readEl = document.getElementById("read");
const stepsEl = document.getElementById("steps");
const modelsEl = document.getElementById("models");
const statusEl = document.getElementById("status");
const profileEl = document.getElementById("profile");
const inputEl = document.getElementById("input");
const metaEl = document.getElementById("read-meta");

function pct(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function barRow(label, value, extra) {
  const width = Math.max(0, Math.min(100, (value || 0) * 100));
  return `<div class="row"><div>${label}</div><div class="bar"><span style="width:${width}%"></span></div><div>${pct(value)}</div><div>${extra ?? ""}</div></div>`;
}

function renderRead(read) {
  if (!read) {
    readEl.innerHTML = `<p class="muted">Send a message to score it.</p>`;
    return;
  }
  readEl.innerHTML = `
    <div class="group"><h3>What it is</h3>
      ${barRow(read.kind, read.kindP, "")}
      ${barRow(read.domain, read.domainP, "")}
      ${barRow(read.context, read.contextP, "")}
    </div>
    <div class="group"><h3>How demanding</h3>
      ${barRow("difficulty " + (read.difficulty >= 0.7 ? "difficult" : read.difficulty >= 0.4 ? "moderate" : "easy"), read.difficulty, read.difficulty.toFixed(2))}
      ${barRow("precision " + (read.precision >= 0.66 ? "exact" : "careful"), read.precision, read.precision.toFixed(2))}
      ${barRow("big-model gain " + (read.bigModelGain >= 0.66 ? "material" : "small"), read.bigModelGain, read.bigModelGain.toFixed(2))}
    </div>
    <div class="group"><h3>What a good answer looks like</h3>
      ${barRow("length " + (read.length >= 0.66 ? "long" : "short"), read.length, read.length.toFixed(2))}
      ${barRow("wants speed " + (read.wantsSpeed >= 0.5 ? "yes" : "no"), read.wantsSpeed >= 0.5 ? read.wantsSpeed : 1 - read.wantsSpeed, "—")}
      ${barRow("fresh facts " + (read.freshFacts >= 0.5 ? "yes" : "no"), read.freshFacts >= 0.5 ? read.freshFacts : 1 - read.freshFacts, "—")}
    </div>`;
}

function renderRoute(data) {
  stepsEl.innerHTML = (data.steps || []).map((step, i) => `<li><b>${i + 1}</b> ${step}</li>`).join("");
  modelsEl.innerHTML = (data.models || [])
    .sort((a, b) => a.costHint - b.costHint)
    .map(model => {
      const thinking = model.thinking ? `:${model.thinking}` : "";
      return `<div class="model ${model.selected ? "selected" : ""}">
        <div>${model.ref}${thinking}</div>
        <span class="muted">$${model.costHint.toFixed(5)}</span>
        <span class="muted">${model.tier}</span>
      </div>`;
    })
    .join("");
}

function addMessage(role, text, note) {
  if (note) {
    const p = document.createElement("div");
    p.className = "route-note";
    p.innerHTML = note;
    thread.appendChild(p);
  }
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  thread.appendChild(el);
  thread.scrollTop = thread.scrollHeight;
}

async function send(text) {
  const prompt = (text ?? inputEl.value).trim();
  if (!prompt) return;
  inputEl.value = "";
  addMessage("user", prompt);
  history.push({ role: "user", text: prompt });
  statusEl.textContent = "scoring…";
  try {
    const response = await fetch("/api/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: profileEl.value, prompt, history: history.slice(0, -1) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    renderRead(data.read);
    renderRoute(data);
    const tokens = data.read?.usage ? `${data.read.usage.input_tokens + data.read.usage.output_tokens} tokens` : "";
    metaEl.textContent = `${data.read.latencyMs} ms · ${tokens}`;
    const ref = data.decision?.ref ?? "(none)";
    const thinking = data.decision?.thinking ?? "inherit";
    statusEl.textContent = `routed · ${profileEl.value}`;
    addMessage(
      "assistant",
      `Selected ${ref}:${thinking} on profile ${data.profile}.\nmodel_score ${data.scores.modelScore.toFixed(2)} · thinking_score ${data.scores.thinkingScore.toFixed(2)}\n\nThis playground routes only. Pi still executes the turn on the chosen model.`,
      `<b>${ref}</b> · ${data.decision?.debug?.resolved_model_level ?? ""}`,
    );
    history.push({ role: "assistant", text: `routed to ${ref}` });
  } catch (error) {
    statusEl.textContent = "error";
    addMessage("assistant", String(error.message || error));
  }
}

document.getElementById("composer").addEventListener("submit", event => {
  event.preventDefault();
  send();
});
inputEl.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});
document.getElementById("clear").addEventListener("click", () => {
  history.length = 0;
  thread.innerHTML = "";
  renderRead(null);
  stepsEl.innerHTML = "";
  modelsEl.innerHTML = "";
  metaEl.textContent = "";
  statusEl.textContent = "idle";
});

for (const [label, text] of SAMPLES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => send(text));
  document.getElementById("chips").appendChild(button);
}

const boot = await fetch("/api/config").then(r => r.json());
for (const name of boot.profiles) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  if (name === boot.activeProfile) option.selected = true;
  profileEl.appendChild(option);
}
statusEl.textContent = boot.jev ? `ready · ${boot.activeProfile}` : "no TypeSafe API key";
renderRead(null);
