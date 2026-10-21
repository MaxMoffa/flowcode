var FlowcodeView = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/chat/chatModel.ts
	function initialChat() {
		return {
			items: [],
			plan: null,
			commands: [],
			currentModeId: null,
			status: "starting",
			lastSeq: -1,
			turnActive: false,
			notice: null
		};
	}
	/** Updates that show the agent is making progress again, so a notice is stale. */
	var PROGRESS_UPDATES = /* @__PURE__ */ new Set([
		"agent_message_chunk",
		"agent_thought_chunk",
		"tool_call",
		"tool_call_update"
	]);
	function statusOf(items, turnActive, current) {
		if (current === "exited" || current === "starting") return current;
		if (items.some((i) => i.type === "permission" && i.resolved === void 0)) return "waiting";
		return turnActive ? "busy" : "idle";
	}
	function withItems(state, items, turnActive = state.turnActive) {
		return {
			...state,
			items,
			turnActive,
			status: statusOf(items, turnActive, state.status)
		};
	}
	/** Appends `text` to the last item when it has `type`, else starts a new one. */
	function appendText(state, type, text, seq) {
		const last = state.items[state.items.length - 1];
		if (type === "user" && last?.type === "user" && last.local) return state;
		return withItems(state, last && last.type === type ? [...state.items.slice(0, -1), {
			...last,
			text: last.text + text
		}] : [...state.items, {
			type,
			id: `${type}-${seq}`,
			text
		}], type === "user" ? state.turnActive : true);
	}
	function textOf(update) {
		const content = update.content;
		return content?.type === "text" && typeof content.text === "string" ? content.text : null;
	}
	function upsertTool(state, patch) {
		const index = state.items.findIndex((i) => i.type === "tool" && i.id === patch.toolCallId);
		const items = [...state.items];
		if (index < 0) items.push({
			type: "tool",
			id: patch.toolCallId,
			call: patch
		});
		else {
			const prev = items[index];
			const merged = { ...prev.call };
			for (const [key, value] of Object.entries(patch)) if (value !== void 0 && value !== null) merged[key] = value;
			items[index] = {
				...prev,
				call: merged
			};
		}
		return withItems(state, items, true);
	}
	function applyUpdate(state, update, seq) {
		switch (update.sessionUpdate) {
			case "user_message_chunk":
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const text = textOf(update);
				if (text === null) return state;
				return appendText(state, update.sessionUpdate === "user_message_chunk" ? "user" : update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought", text, seq);
			}
			case "tool_call":
			case "tool_call_update": return upsertTool(state, update);
			case "plan": return {
				...state,
				plan: update.entries ?? [],
				turnActive: true,
				status: statusOf(state.items, true, state.status)
			};
			case "available_commands_update": return {
				...state,
				commands: update.availableCommands ?? []
			};
			case "current_mode_update": return {
				...state,
				currentModeId: update.currentModeId ?? state.currentModeId
			};
			default: return state;
		}
	}
	function reduce(state, ev) {
		switch (ev.kind) {
			case "update": {
				const next = applyUpdate(state, ev.update, ev.seq);
				return PROGRESS_UPDATES.has(ev.update.sessionUpdate) ? {
					...next,
					notice: null
				} : next;
			}
			case "ext": {
				if (ev.method !== "_session/retrying" || !state.turnActive) return state;
				const params = ev.params ?? {};
				return {
					...state,
					notice: {
						kind: "retrying",
						category: typeof params.category === "string" ? params.category : "",
						detail: typeof params.detail === "string" ? params.detail : ""
					}
				};
			}
			case "user": return withItems(state, [...state.items, {
				type: "user",
				id: `user-${ev.seq}`,
				text: ev.text,
				local: true
			}], true);
			case "permission": return withItems(state, [...state.items, {
				type: "permission",
				id: `perm-${ev.requestId}`,
				requestId: ev.requestId,
				toolCall: ev.toolCall,
				options: ev.options
			}]);
			case "permissionResolved": return withItems(state, state.items.map((i) => i.type === "permission" && i.requestId === ev.requestId ? {
				...i,
				resolved: ev.optionId
			} : i));
			case "turnEnd": return {
				...withItems(state, state.items, false),
				notice: null
			};
			case "error": return {
				...withItems(state, [...state.items, {
					type: "error",
					id: `error-${ev.seq}`,
					message: ev.message
				}], false),
				notice: null
			};
			case "exit": return {
				...state,
				turnActive: false,
				status: "exited",
				notice: null
			};
			default: return state;
		}
	}
	/** Folds one event into the conversation. Pure: the same events in the same
	* order always give the same state, and one already applied (by `seq`) is skipped. */
	function applyEvent(state, ev) {
		if (ev.seq <= state.lastSeq) return state;
		return {
			...reduce(state, ev),
			lastSeq: ev.seq
		};
	}
	var DIFF_MAX_LINES = 400;
	var DIFF_FALLBACK_LINES = 200;
	function splitLines(text) {
		if (text === "") return [];
		const lines = text.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		return lines;
	}
	/** Line diff by longest common subsequence. Past 400 lines on either side it
	* gives up on matching and lists the first 200 new lines as additions. */
	function lineDiff(oldText, newText) {
		const a = splitLines(oldText ?? "");
		const b = splitLines(newText);
		if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return b.slice(0, DIFF_FALLBACK_LINES).map((text) => ({
			type: "add",
			text
		}));
		const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
		for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		const rows = [];
		let i = 0;
		let j = 0;
		while (i < a.length && j < b.length) if (a[i] === b[j]) {
			rows.push({
				type: "ctx",
				text: a[i]
			});
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push({
			type: "del",
			text: a[i++]
		});
		else rows.push({
			type: "add",
			text: b[j++]
		});
		while (i < a.length) rows.push({
			type: "del",
			text: a[i++]
		});
		while (j < b.length) rows.push({
			type: "add",
			text: b[j++]
		});
		return rows;
	}
	//#endregion
	//#region src/chat/chatLinks.ts
	/** Web links in the text an agent wrote. Shared by the desktop chat and the
	* phone's (mobile/src/ChatBody.tsx), so both find the same ones. */
	/** A markdown `[text](url)` (one level of parentheses allowed in the url), or a bare url. */
	var LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)|https?:\/\/[^\s<>"'`]+/gi;
	var TRAILING = /[.,;:!?)\]}]/;
	/** Longest url handed to the opener or the preview fetch. */
	var MAX_URL_LENGTH = 2048;
	/** Drops sentence punctuation stuck to a bare url, but keeps a `)` that closes a `(` inside it. */
	function trimUrl(url) {
		let u = url;
		while (u.length > 0 && TRAILING.test(u[u.length - 1])) {
			if (u.endsWith(")") && u.split("(").length >= u.split(")").length) break;
			u = u.slice(0, -1);
		}
		return u;
	}
	/** One line of text cut into plain pieces and links (`[text](url)`, or a bare http(s) url, which is its own text). */
	function splitLinks(text) {
		const parts = [];
		let last = 0;
		for (const m of text.matchAll(LINK_RE)) {
			const start = m.index ?? 0;
			const url = m[2] ?? trimUrl(m[0]);
			if (url.length > MAX_URL_LENGTH || !/^https?:\/\/[^/?#\s]+/i.test(url)) continue;
			const end = m[2] ? start + m[0].length : start + url.length;
			if (start > last) parts.push({ text: text.slice(last, start) });
			parts.push({
				text: m[1] ?? url,
				url
			});
			last = end;
		}
		if (last < text.length) parts.push({ text: text.slice(last) });
		return parts;
	}
	//#endregion
	//#region sdk/agent-view/markdown.ts
	var CODE_SPAN = /`([^`\n]+)`/g;
	var BOLD = /\*\*(?=\S)([^\n]*?\S)\*\*/g;
	var FENCE = /^\s*```\s*([^\s`]*)/;
	var BULLET = /^\s*[-*]\s+(.*)$/;
	/** Text without code spans, cut into plain pieces and links. */
	function linkParts(text) {
		return splitLinks(text).map((part) => part.url ? {
			type: "link",
			text: part.text,
			url: part.url
		} : {
			type: "text",
			text: part.text
		});
	}
	function boldParts(text) {
		const out = [];
		let last = 0;
		for (const m of text.matchAll(BOLD)) {
			const start = m.index ?? 0;
			if (start > last) out.push(...linkParts(text.slice(last, start)));
			out.push({
				type: "bold",
				children: linkParts(m[1])
			});
			last = start + m[0].length;
		}
		if (last < text.length) out.push(...linkParts(text.slice(last)));
		return out;
	}
	/** One line of text as inline pieces; code spans are cut out first, so nothing inside them is a link or bold. */
	function parseInline(line) {
		const out = [];
		let last = 0;
		for (const m of line.matchAll(CODE_SPAN)) {
			const start = m.index ?? 0;
			if (start > last) out.push(...boldParts(line.slice(last, start)));
			out.push({
				type: "code",
				text: m[1]
			});
			last = start + m[0].length;
		}
		if (last < line.length) out.push(...boldParts(line.slice(last)));
		return out;
	}
	/** The blocks of a text: fenced code (an unclosed fence runs to the end), bullet lists and paragraphs (separated by blank lines). */
	function parseMarkdown(text) {
		const blocks = [];
		const rows = text.replace(/\r\n?/g, "\n").split("\n");
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const fence = FENCE.exec(row);
			if (fence) {
				const code = [];
				for (i++; i < rows.length && !rows[i].trimStart().startsWith("```"); i++) code.push(rows[i]);
				blocks.push({
					type: "code",
					text: code.join("\n"),
					lang: fence[1]
				});
				continue;
			}
			if (row.trim() === "") continue;
			const previous = i > 0 ? rows[i - 1] : "";
			const last = blocks[blocks.length - 1];
			const bullet = BULLET.exec(row);
			if (bullet) {
				const item = parseInline(bullet[1]);
				if (last?.type === "list" && BULLET.test(previous)) last.items.push(item);
				else blocks.push({
					type: "list",
					items: [item]
				});
				continue;
			}
			const line = parseInline(row);
			if (last?.type === "paragraph" && previous.trim() !== "") last.lines.push(line);
			else blocks.push({
				type: "paragraph",
				lines: [line]
			});
		}
		return blocks;
	}
	function inlineNodes(parts, doc) {
		return parts.map((part) => {
			switch (part.type) {
				case "text": return doc.createTextNode(part.text);
				case "code": {
					const node = doc.createElement("code");
					node.className = "md-code";
					node.textContent = part.text;
					return node;
				}
				case "bold": {
					const node = doc.createElement("strong");
					node.append(...inlineNodes(part.children, doc));
					return node;
				}
				case "link": {
					const node = doc.createElement("span");
					node.className = "md-link";
					node.title = part.url;
					node.textContent = part.text;
					return node;
				}
			}
		});
	}
	/** The text as DOM nodes, ready to append. Only elements built here, with the agent's text in text nodes. */
	function renderMarkdown(text, doc = document) {
		const fragment = doc.createDocumentFragment();
		for (const block of parseMarkdown(text)) if (block.type === "code") {
			const pre = doc.createElement("pre");
			pre.className = "md-pre";
			const code = doc.createElement("code");
			code.textContent = block.text;
			pre.append(code);
			fragment.append(pre);
		} else if (block.type === "list") {
			const list = doc.createElement("ul");
			list.className = "md-list";
			for (const item of block.items) {
				const li = doc.createElement("li");
				li.append(...inlineNodes(item, doc));
				list.append(li);
			}
			fragment.append(list);
		} else {
			const p = doc.createElement("p");
			p.className = "md-p";
			block.lines.forEach((line, index) => {
				if (index > 0) p.append(doc.createElement("br"));
				p.append(...inlineNodes(line, doc));
			});
			fragment.append(p);
		}
		return fragment;
	}
	//#endregion
	//#region sdk/agent-view/index.ts
	var API_VERSION = 1;
	/** Says hello to the host, takes the port it answers with and resolves after the first `init`. */
	function connect({ window: win = window } = {}) {
		return new Promise((resolve) => {
			const listeners = {
				model: /* @__PURE__ */ new Set(),
				status: /* @__PURE__ */ new Set(),
				theme: /* @__PURE__ */ new Set(),
				init: /* @__PURE__ */ new Set(),
				error: /* @__PURE__ */ new Set()
			};
			const emit = (type, value) => {
				for (const listener of listeners[type]) listener(value);
			};
			let port = null;
			let init = null;
			let model = initialChat();
			let timing = /* @__PURE__ */ new Map();
			let status = null;
			let theme = null;
			const request = (message) => port?.postMessage(message);
			const client = {
				get init() {
					return init;
				},
				get model() {
					return model;
				},
				get timing() {
					return timing;
				},
				get status() {
					return status;
				},
				get theme() {
					return theme;
				},
				on(type, listener) {
					const set = listeners[type];
					set.add(listener);
					return () => void set.delete(listener);
				},
				send: (text) => request({
					type: "send",
					text
				}),
				cancel: () => request({ type: "cancel" }),
				setMode: (modeId) => request({
					type: "setMode",
					modeId
				}),
				openFile: (path) => request({
					type: "openFile",
					path
				}),
				switchView: (viewId) => request({
					type: "switchView",
					viewId
				}),
				can: (permission) => init?.permissions.includes(permission) ?? false
			};
			function applyEvents(events) {
				for (const event of events) {
					const before = model.items;
					model = applyEvent(model, event);
					model.items.forEach((item, i) => {
						if (item === before[i]) return;
						const known = timing.get(item.id);
						timing.set(item.id, {
							start: known?.start ?? event.at,
							end: event.at
						});
					});
				}
				emit("model", model);
			}
			function onMessage(e) {
				const message = e.data;
				switch (message.type) {
					case "init": {
						const first = init === null;
						init = message;
						model = initialChat();
						timing = /* @__PURE__ */ new Map();
						status = null;
						theme = message.theme;
						if (first) resolve(client);
						else {
							emit("init", message);
							emit("model", model);
						}
						break;
					}
					case "events":
						applyEvents(message.events);
						break;
					case "status":
						status = {
							status: message.status,
							queued: message.queued,
							currentModeId: message.currentModeId
						};
						emit("status", status);
						break;
					case "theme":
						theme = message.theme;
						emit("theme", message.theme);
						break;
					case "error": emit("error", message);
				}
			}
			function onConnect({ source, data, ports }) {
				if (source !== win.parent || data?.type !== "flowcode:connect" || !ports[0]) return;
				win.removeEventListener("message", onConnect);
				port = ports[0];
				port.onmessage = onMessage;
			}
			win.addEventListener("message", onConnect);
			win.parent.postMessage({
				type: "flowcode:hello",
				apiVersion: API_VERSION
			}, "*");
		});
	}
	/** Puts the theme's tokens on `root` as CSS variables and sets `color-scheme`. */
	function applyTheme(theme, root = document.documentElement) {
		for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
		root.style.colorScheme = theme.scheme;
	}
	//#endregion
	exports.applyTheme = applyTheme;
	exports.connect = connect;
	exports.lineDiff = lineDiff;
	exports.renderMarkdown = renderMarkdown;
	return exports;
})({});
