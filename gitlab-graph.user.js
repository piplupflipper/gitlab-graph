// ==UserScript==
// @name         GitLab Git Graph
// @namespace    https://github.com/ngmtine
// @version      0.1.0
// @description  GitLab のリポジトリグラフを Git Graph 拡張風の見やすい表示に差し替える
// @match        https://gitlab.com/*
// @downloadURL  https://raw.githubusercontent.com/ngmtine/gitlab-graph/master/gitlab-graph.user.js
// @updateURL    https://raw.githubusercontent.com/ngmtine/gitlab-graph/master/gitlab-graph.user.js
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    "use strict";

    // ---------------------------------------------------------------------
    // 定数
    // ---------------------------------------------------------------------

    /** ネイティブのグラフページの外枠。Vue が描き終わるまで存在しない */
    const NATIVE_ROOT_SELECTOR = ".project-network";
    /** Vue の描画待ちを諦めるまでの時間 (ms) */
    const NATIVE_WAIT_MS = 10000;

    const ROW_HEIGHT = 26;
    /** レーン 1 本あたりの横幅 (px) */
    const LANE_WIDTH = 14;
    /** 左端レーンの中心 x (px) */
    const LANE_ORIGIN_X = 9;
    const DOT_RADIUS = 3.5;
    // bot が単発コミットのブランチを大量に作るリポジトリでは同時レーン数が数十〜数百になる
    // (2026-08-01 に gitlab.com の gitlab-org/gitlab-foss で確認)。
    // グラフ列を伸ばし放題にするとコミットタイトルが画面外へ押し出されるので、描画するレーン数を頭打ちにする
    const MAX_VISIBLE_LANES = 16;
    /** グラフ列の右端に置くフェードの幅 (px)。レーンが切り詰められているときだけ確保する */
    const GRAPH_FADE_WIDTH = 12;
    /** グラフ列の右側の余白 (px) */
    const GRAPH_PAD = 4;
    // レーンが 1 本 (18px) でも "GRAPH" ヘッダは収まらず、隣の DESCRIPTION と重なって見える。
    // 0 行のときも列が潰れないよう、ヘッダが収まる幅を下限にする
    const MIN_GRAPH_WIDTH = 56;

    const PER_PAGE = 100;
    /** 初回に直列で取得する回数 (全ブランチモードなら日時窓 3 回、ref_name モードなら 3 ページ) */
    const INITIAL_BATCHES = 3;
    /** diff API の取得上限。これを超える変更ファイルは省略する */
    const DIFF_LIMIT = 100;

    /** フォーカス行が画面内に収まっているとみなすための上下マージン (px) */
    const SCROLL_MARGIN_PX = 80;
    /** y の 1 打目を覚えておく時間 (ms) */
    const Y_SEQUENCE_MS = 600;
    /** ブランチ候補の検索を投げるまでの待ち時間 (ms) */
    const BRANCH_SEARCH_DEBOUNCE_MS = 250;
    const TOAST_MS = 2000;

    // ライト/ダークのどちらの背景でも判読できる中間トーンで揃える。
    // レーン index の剰余で割り当てるだけなので、隣り合う色が似ないよう色相を散らしてある。
    const LANE_COLORS = [
        "#3b8ee0",
        "#e05fa8",
        "#3fbf4f",
        "#d98a2b",
        "#a06ee0",
        "#e0544e",
        "#22b6ac",
        "#c46be0",
        "#8ab82e",
        "#dc6a3a",
        "#7a63e0",
        "#c8a72b",
    ];

    const SVG_NS = "http://www.w3.org/2000/svg";
    const SHA_ATTR = "data-glg-sha";
    const SELECTED_ATTR = "data-glg-selected";

    // ---------------------------------------------------------------------
    // 状態
    // ---------------------------------------------------------------------

    const state = {
        /** プロジェクトのフルパス (サブグループ込み) */
        projectPath: "",
        /** URL から読んだ ref。空なら default_branch で埋める */
        ref: "",
        defaultBranch: "",

        /** "all" なら全ブランチ、"ref" なら state.refName 単独 */
        mode: "all",
        refName: "",

        commits: [],
        /** 追加ロード時の重複除外用 */
        loadedShas: new Set(),
        /** 次に取りに行くページ番号 (1 始まり)。ref_name モードでのみ使う */
        nextPage: 1,
        /** 次の窓の上限日時 (ISO)。全ブランチモードでのみ使う。空なら最新から */
        until: "",
        hasMore: true,
        loading: false,

        /** チップ用。branches API の 1 ページ目 (絞り込みなし) */
        branches: [],
        tags: [],
        /** datalist の候補にするブランチ名。ブランチ検索のたびに入れ替わる */
        branchOptions: [],
        /** sha -> [{ type, name, isDefault }] */
        refsBySha: new Map(),

        /** assignLanes の結果 */
        graphRows: [],
        laneCount: 1,
        /** sha -> graphRow */
        rowsBySha: new Map(),

        filter: "",
        visibleRows: [],

        selectedSha: "",
        expandedSha: "",
        /** sha -> { detail, diff, truncated } */
        detailCache: new Map(),
        /** 詳細取得の世代。応答が返るまでに別の行を開いたら捨てる */
        detailToken: 0,

        /** [{ source, message }]。source ごとに消せるようにして、再取得で他のエラーを巻き添えにしない */
        errors: [],
        statusText: "",
        /** エラーではないが伝えたい状況 (窓が進まなくなった等) */
        notice: "",

        nativeMode: false,
        nativeRoot: null,
    };

    const ui = {
        root: null,
        status: null,
        branchInput: null,
        branchList: null,
        filterInput: null,
        moreButton: null,
        countLabel: null,
        refLabel: null,
        nativeButton: null,
        graphCol: null,
        graphHead: null,
        tbody: null,
    };

    let toastElement = null;
    let toastTimer = 0;
    /** y シーケンスの 1 打目を押した時刻 (ms)。0 は待ち状態なし */
    let pendingYAt = 0;
    let branchSearchTimer = 0;
    let branchSearchController = null;

    class ApiError extends Error {
        constructor(status) {
            super(`HTTP ${status}`);
            this.name = "ApiError";
            this.status = status;
        }
    }

    // ---------------------------------------------------------------------
    // スタイル
    // ---------------------------------------------------------------------

    const injectStyle = () => {
        const style = document.createElement("style");
        // 配色は CSS 変数に寄せ、GitLab のダークテーマ (body か html の gl-dark) で切り替える。
        // 自前のサブツリーにしか当たらない選択子なので、非表示の強制以外に !important は使わない。
        style.textContent = `.glg-hidden {
    display: none !important;
}

.glg-root {
    --glg-bg: #ffffff;
    /* グラデーションの透明側。transparent (= rgba(0,0,0,0)) を使うと環境によって灰色に濁る */
    --glg-bg-fade: rgba(255, 255, 255, 0);
    --glg-bg-alt: #fafafa;
    --glg-bg-selected: #e4eefc;
    --glg-border: #dcdcde;
    --glg-fg: #1f1e24;
    --glg-fg-muted: #737278;
    --glg-accent: #1f75cb;
    --glg-danger: #b02a37;
    --glg-added: #217645;
    --glg-removed: #b02a37;

    margin: 8px 0 24px;
    border: 1px solid var(--glg-border);
    border-radius: 6px;
    background: var(--glg-bg);
    color: var(--glg-fg);
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif;
    font-size: 13px;
    line-height: 1.5;
}

body.gl-dark .glg-root,
html.gl-dark .glg-root {
    --glg-bg: #1f1e24;
    --glg-bg-fade: rgba(31, 30, 36, 0);
    --glg-bg-alt: #28272d;
    --glg-bg-selected: #2f3a52;
    --glg-border: #3b3a44;
    --glg-fg: #ececef;
    --glg-fg-muted: #a4a3ab;
    --glg-accent: #63a6e9;
    --glg-danger: #f57f6c;
    --glg-added: #4dbf7a;
    --glg-removed: #f57f6c;
}

.glg-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--glg-border);
    background: var(--glg-bg-alt);
}

.glg-toolbar input,
.glg-toolbar button {
    box-sizing: border-box;
    height: 28px;
    margin: 0;
    padding: 0 8px;
    border: 1px solid var(--glg-border);
    border-radius: 4px;
    background: var(--glg-bg);
    color: var(--glg-fg);
    font-family: inherit;
    font-size: 13px;
    line-height: 26px;
}

.glg-toolbar input {
    flex: 1 1 200px;
    min-width: 140px;
    max-width: 420px;
}

/* ブランチ候補の入力はフィルタより控えめな幅にする */
.glg-toolbar input.glg-branch {
    flex: 0 1 260px;
}

.glg-toolbar button {
    cursor: pointer;
}

.glg-toolbar button:disabled {
    opacity: 0.5;
    cursor: default;
}

.glg-spacer {
    flex: 1 1 auto;
}

.glg-count {
    max-width: 360px;
    overflow: hidden;
    color: var(--glg-fg-muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.glg-ref-label {
    color: var(--glg-fg-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: nowrap;
}

.glg-status {
    padding: 6px 10px;
    border-bottom: 1px solid var(--glg-border);
    color: var(--glg-fg-muted);
    font-size: 12px;
}

.glg-status:empty {
    display: none;
}

.glg-status-error {
    color: var(--glg-danger);
}

.glg-status-note {
    color: var(--glg-fg);
}

.glg-table-wrap {
    overflow-x: auto;
}

/* table-layout: fixed + colgroup で列幅を固定する。
   Description 列 (幅指定なし) が残り幅を全部取り、Graph 列に押し出されないようにするのが狙い。
   min-width を切っておき、狭いビューポートではタイトルを潰さず横スクロールさせる */
.glg-table {
    width: 100%;
    min-width: 680px;
    border-collapse: collapse;
    table-layout: fixed;
    background: var(--glg-bg);
    color: var(--glg-fg);
    font-size: 13px;
}

/* 列が狭いときにヘッダの文字が隣の列へはみ出して重なるのを防ぐ */
.glg-table th {
    padding: 4px 8px;
    border-bottom: 1px solid var(--glg-border);
    background: var(--glg-bg-alt);
    color: var(--glg-fg-muted);
    overflow: hidden;
    font-size: 11px;
    font-weight: 600;
    text-align: left;
    text-overflow: ellipsis;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
}

.glg-table td {
    height: ${ROW_HEIGHT}px;
    padding: 0 8px;
    border: none;
    overflow: hidden;
    vertical-align: middle;
    white-space: nowrap;
}

.glg-row {
    cursor: pointer;
}

.glg-row:hover {
    background: var(--glg-bg-alt);
}

.glg-row[${SELECTED_ATTR}] {
    background: var(--glg-bg-selected);
}

.glg-cell-graph,
.glg-cell-graph-detail {
    padding: 0;
    position: relative;
    overflow: hidden;
}

.glg-cell-graph-detail svg {
    position: absolute;
    top: 0;
    left: 0;
}

/* 上限を超えたレーンは SVG の外に出るので、ここでクリップする */
.glg-graph {
    display: block;
    overflow: hidden;
}

/* 「まだ右に続く」ことを示すフェード。レーンを切り詰めているときだけ出す */
.glg-clipped .glg-cell-graph::after,
.glg-clipped .glg-cell-graph-detail::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: ${GRAPH_FADE_WIDTH}px;
    background: linear-gradient(to right, var(--glg-bg-fade), var(--glg-bg));
    pointer-events: none;
}

.glg-head-graph-more {
    color: var(--glg-fg-muted);
    font-weight: 400;
}

.glg-graph-dimmed {
    opacity: 0.35;
}

.glg-dot {
    stroke: var(--glg-bg);
    stroke-width: 1.5;
}

.glg-dot-merge {
    fill: var(--glg-bg);
    stroke-width: 2;
}

.glg-desc-inner {
    display: flex;
    align-items: center;
    gap: 6px;
    height: ${ROW_HEIGHT}px;
    overflow: hidden;
}

.glg-chip {
    flex: 0 0 auto;
    max-width: 220px;
    overflow: hidden;
    padding: 0 6px;
    border: 1px solid var(--glg-border);
    border-radius: 9px;
    color: var(--glg-fg);
    font-size: 11px;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.glg-chip-default {
    font-weight: 700;
}

.glg-chip-tag {
    border-style: dashed;
    border-radius: 3px;
    color: var(--glg-fg-muted);
}

.glg-title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.glg-author,
.glg-date {
    color: var(--glg-fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
}

.glg-date,
.glg-sha {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
}

.glg-sha {
    color: var(--glg-fg-muted);
}

.glg-detail-cell {
    padding: 0 8px 10px;
    white-space: normal;
}

.glg-detail-panel {
    padding: 8px 10px;
    border-left: 2px solid var(--glg-border);
    background: var(--glg-bg-alt);
    white-space: normal;
}

.glg-detail-message {
    margin: 0 0 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
}

.glg-detail-meta {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 2px 8px;
    margin-bottom: 8px;
    font-size: 12px;
}

.glg-detail-key {
    color: var(--glg-fg-muted);
}

.glg-detail-value {
    word-break: break-all;
}

.glg-detail-value a,
.glg-detail-actions a {
    color: var(--glg-accent);
}

.glg-parent-link {
    margin-right: 8px;
    padding: 0;
    border: none;
    background: none;
    color: var(--glg-accent);
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    text-decoration: underline;
}

.glg-stat-added {
    color: var(--glg-added);
}

.glg-stat-removed {
    color: var(--glg-removed);
}

.glg-files {
    margin: 0 0 8px;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
    list-style: none;
}

.glg-file {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.7;
    word-break: break-all;
}

.glg-badge {
    flex: 0 0 auto;
    width: 16px;
    border-radius: 3px;
    background: var(--glg-border);
    color: var(--glg-fg);
    font-size: 10px;
    line-height: 16px;
    text-align: center;
}

.glg-badge-a {
    background: rgba(33, 118, 69, 0.25);
    color: var(--glg-added);
}

.glg-badge-d {
    background: rgba(176, 42, 55, 0.25);
    color: var(--glg-removed);
}

.glg-badge-r {
    background: rgba(31, 117, 203, 0.25);
    color: var(--glg-accent);
}

.glg-detail-note {
    color: var(--glg-fg-muted);
    font-size: 12px;
}

.glg-detail-error {
    color: var(--glg-danger);
    font-size: 12px;
}

.glg-empty {
    padding: 12px 10px;
    color: var(--glg-fg-muted);
}

.glg-toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483000;
    max-width: 40vw;
    margin: 0;
    padding: 10px 14px;
    border: 1px solid #3d3d4d;
    border-radius: 6px;
    background: #1c1c24;
    color: #f2f2f5;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif;
    font-size: 13px;
    line-height: 1.5;
}`;
        (document.head || document.documentElement).appendChild(style);
    };

    // ---------------------------------------------------------------------
    // トースト
    // ---------------------------------------------------------------------

    const showToast = (message) => {
        if (!toastElement) {
            toastElement = document.createElement("div");
            toastElement.className = "glg-toast";
        }
        toastElement.textContent = message;
        (document.body || document.documentElement).appendChild(toastElement);

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastElement.remove();
        }, TOAST_MS);
    };

    // ---------------------------------------------------------------------
    // ユーティリティ
    // ---------------------------------------------------------------------

    const pad2 = (value) => String(value).padStart(2, "0");

    /** YYYY-MM-DD HH:mm (ローカルタイム) */
    const formatDateTime = (iso) => {
        const date = new Date(iso ?? "");
        if (Number.isNaN(date.getTime())) return "";
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    };

    const describeError = (error) => {
        if (error instanceof ApiError) return `HTTP ${error.status}`;
        return error?.message ?? "不明なエラー";
    };

    const pushError = (source, message) => {
        state.errors.push({ source, message });
    };

    const clearErrors = (source) => {
        state.errors = state.errors.filter((entry) => entry.source !== source);
    };

    const hasError = (source) => state.errors.some((entry) => entry.source === source);

    const laneColor = (laneIndex) => LANE_COLORS[laneIndex % LANE_COLORS.length];

    const laneX = (laneIndex) => LANE_ORIGIN_X + laneIndex * LANE_WIDTH;

    const visibleLaneCount = () => Math.min(Math.max(state.laneCount, 1), MAX_VISIBLE_LANES);

    /** 表示上限を超えて描けないレーンの本数 */
    const hiddenLaneCount = () => Math.max(state.laneCount - MAX_VISIBLE_LANES, 0);

    const isLaneClipped = () => hiddenLaneCount() > 0;

    const graphWidth = () =>
        Math.max(
            visibleLaneCount() * LANE_WIDTH + GRAPH_PAD + (isLaneClipped() ? GRAPH_FADE_WIDTH : 0),
            MIN_GRAPH_WIDTH,
        );

    // 上限を超えたレーンは最右の可視レーンに寄せて描く。
    // 単に切り落とすと、そこにいるコミットのドットまで消えて行が空になってしまう
    const laneDrawX = (laneIndex) =>
        laneX(isLaneClipped() ? Math.min(laneIndex, MAX_VISIBLE_LANES - 1) : laneIndex);

    const svgEl = (name, attrs) => {
        const el = document.createElementNS(SVG_NS, name);
        for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
        return el;
    };

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    // ---------------------------------------------------------------------
    // REST API v4
    // ---------------------------------------------------------------------

    // same-origin なのでセッション Cookie がそのまま効き、アクセストークンを持たせる必要がない
    const projectApi = (path, params) => {
        const base = `${location.origin}/api/v4/projects/${encodeURIComponent(state.projectPath)}${path}`;
        if (!params) return base;
        return `${base}?${new URLSearchParams(params).toString()}`;
    };

    const fetchJson = async (url, signal) => {
        const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new ApiError(response.status);
        return response.json();
    };

    const fetchProject = () => fetchJson(projectApi("", null));

    // search を付けるとサーバ側で絞り込める。付けないとアルファベット順の先頭 100 件しか見えない
    const fetchBranches = (search, signal) => {
        const params = { per_page: String(PER_PAGE) };
        if (search) params.search = search;
        return fetchJson(projectApi("/repository/branches", params), signal);
    };

    const fetchTags = () => fetchJson(projectApi("/repository/tags", { per_page: String(PER_PAGE) }));

    // all=true では page が無視され、page=1 と page=2 が同一の 100 件を返す
    // (2026-08-01 に gitlab.com の gitlab-org/gitlab-foss で実測)。
    // そのため全ブランチモードは page ではなく until (コミット日時) で窓をずらして継ぎ足す。
    // ref_name 指定なら page ベースのページングは正常に機能するので、そちらは page を使う。
    // 並びはどのモードでもクライアント側で組み直すので、サーバ側の並び替えは要求しない。
    const fetchCommitBatch = () => {
        const params = { per_page: String(PER_PAGE) };
        if (state.mode === "ref") {
            params.ref_name = state.refName;
            params.page = String(state.nextPage);
        } else {
            params.all = "true";
            if (state.until) params.until = state.until;
        }
        return fetchJson(projectApi("/repository/commits", params));
    };

    const fetchCommitDetail = (sha) => fetchJson(projectApi(`/repository/commits/${encodeURIComponent(sha)}`, null));

    const fetchCommitDiff = (sha) =>
        fetchJson(projectApi(`/repository/commits/${encodeURIComponent(sha)}/diff`, { per_page: String(DIFF_LIMIT) }));

    const normalizeCommit = (raw) => ({
        sha: raw.id ?? "",
        shortSha: raw.short_id ?? String(raw.id ?? "").slice(0, 8),
        title: raw.title ?? "",
        authorName: raw.author_name ?? "",
        committedDate: raw.committed_date ?? raw.created_at ?? "",
        time: Date.parse(raw.committed_date ?? raw.created_at ?? "") || 0,
        parents: Array.isArray(raw.parent_ids) ? raw.parent_ids.filter((id) => typeof id === "string") : [],
        webUrl: raw.web_url ?? "",
    });

    const commitWebUrl = (commit) =>
        commit.webUrl || `${location.origin}/${state.projectPath}/-/commit/${commit.sha}`;

    // ---------------------------------------------------------------------
    // トポロジカルソート
    // ---------------------------------------------------------------------

    // commits API の並びは「子が親より先」を保証しない (2026-08-01 に gitlab.com で実測。
    // until で窓をずらして継ぎ足す全ブランチモードでは、窓をまたいだ並びはそもそもトポロジカルにならず、
    // 窓の中でも昇順で返る例を観測した)。
    // API の並びを信用せず、ロード済みウィンドウ内で並べ直す。

    /** 同じ親を 2 度持つコミット (git 的には有効) で辺を二重に数えない */
    const uniqueParents = (parents) => {
        const seen = new Set();
        const result = [];
        for (const parent of parents) {
            if (seen.has(parent)) continue;
            seen.add(parent);
            result.push(parent);
        }
        return result;
    };

    /** 新しいコミットを先に出す。同時刻は sha で決定的に並べる */
    const compareCommits = (a, b) => {
        if (b.time !== a.time) return b.time - a.time;
        return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
    };

    const topoSortCommits = (commits) => {
        const byId = new Map();
        for (const commit of commits) byId.set(commit.sha, commit);

        // 「ウィンドウ内に子を持たないコミット」を起点にする Kahn 法。辺は 子 -> 親
        const childCount = new Map();
        for (const commit of commits) childCount.set(commit.sha, 0);
        for (const commit of commits) {
            for (const parent of uniqueParents(commit.parents)) {
                if (childCount.has(parent)) childCount.set(parent, childCount.get(parent) + 1);
            }
        }

        // ready は committed_date 降順を保つ。同時に ready になったものは新しい方を先に出す
        const ready = [];
        const pushReady = (commit) => {
            let low = 0;
            let high = ready.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (compareCommits(commit, ready[mid]) < 0) high = mid;
                else low = mid + 1;
            }
            ready.splice(low, 0, commit);
        };

        for (const commit of commits) {
            if (childCount.get(commit.sha) === 0) pushReady(commit);
        }

        const ordered = [];
        while (ready.length > 0) {
            const commit = ready.shift();
            ordered.push(commit);
            for (const parent of uniqueParents(commit.parents)) {
                if (!childCount.has(parent)) continue;
                const remaining = childCount.get(parent) - 1;
                childCount.set(parent, remaining);
                if (remaining === 0) pushReady(byId.get(parent));
            }
        }

        // 壊れたデータ (親子関係の循環など) でもコミットを黙って落とさない
        if (ordered.length < commits.length) {
            const emitted = new Set(ordered.map((commit) => commit.sha));
            const rest = commits.filter((commit) => !emitted.has(commit.sha)).sort(compareCommits);
            ordered.push(...rest);
        }

        return ordered;
    };

    // ---------------------------------------------------------------------
    // レーン割り当て
    // ---------------------------------------------------------------------

    // lanes[i] は「レーン i が次に期待する sha」。null は空きレーン。
    // ウィンドウ外の親を期待したままのレーンは最後まで埋まらないので、下端まで線が伸びる。
    const assignLanes = (ordered) => {
        const lanes = [];
        const rows = [];
        let laneCount = 0;

        const noteLane = (index) => {
            if (index + 1 > laneCount) laneCount = index + 1;
        };

        const takeFreeLane = (blocked) => {
            for (let i = 0; i < lanes.length; i += 1) {
                if (lanes[i] === null && !blocked.has(i)) return i;
            }
            lanes.push(null);
            return lanes.length - 1;
        };

        for (const commit of ordered) {
            const expecting = [];
            for (let i = 0; i < lanes.length; i += 1) {
                if (lanes[i] === commit.sha) expecting.push(i);
            }

            // この行で解放したレーンは同じ行で再利用しない (合流と分岐が同じ位置で重なって読めなくなる)
            const blocked = new Set();

            // 期待しているレーンが無ければブランチ先端。左端の空きレーンを確保する
            const lane = expecting.length === 0 ? takeFreeLane(blocked) : expecting[0];
            noteLane(lane);

            // 通過するだけのレーン。合流するレーンを解放する前に数える
            const passLanes = [];
            for (let i = 0; i < lanes.length; i += 1) {
                if (i === lane) continue;
                if (lanes[i] === null) continue;
                if (lanes[i] === commit.sha) continue;
                passLanes.push(i);
                noteLane(i);
            }

            // 期待していた他のレーンはドットへカーブして合流し、解放される
            const merges = [];
            for (let k = 1; k < expecting.length; k += 1) {
                const index = expecting[k];
                merges.push(index);
                lanes[index] = null;
                blocked.add(index);
                noteLane(index);
            }

            const parents = uniqueParents(commit.parents);

            // 自分のレーンは第 1 親を期待するようになる。親が無ければ閉じる
            lanes[lane] = parents.length > 0 ? parents[0] : null;
            if (lanes[lane] === null) blocked.add(lane);

            // 第 2 親以降は、既にその sha を期待しているレーンへ繋ぐか、空きレーンを新規確保する
            const branches = [];
            for (let k = 1; k < parents.length; k += 1) {
                const parent = parents[k];
                let target = lanes.indexOf(parent);
                if (target === -1) {
                    target = takeFreeLane(blocked);
                    lanes[target] = parent;
                }
                branches.push(target);
                noteLane(target);
            }

            // 右端の空きレーンは畳んで、グラフ列が無駄に広がらないようにする
            while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

            const activeAfter = [];
            for (let i = 0; i < lanes.length; i += 1) {
                if (lanes[i] !== null) activeAfter.push(i);
            }

            rows.push({
                sha: commit.sha,
                commit,
                lane,
                hasTop: expecting.length > 0,
                hasBottom: parents.length > 0,
                isMerge: parents.length > 1,
                passLanes,
                merges,
                branches,
                activeAfter,
            });
        }

        return { rows, laneCount: Math.max(laneCount, 1) };
    };

    // ---------------------------------------------------------------------
    // グラフ描画 (SVG)
    // ---------------------------------------------------------------------

    // 行ごとに独立した小さい SVG を描く。詳細パネルで行の高さが変わっても、
    // 1 枚の巨大な SVG を描き直す必要がない。
    const buildRowGraph = (row) => {
        const width = graphWidth();
        const svg = svgEl("svg", { class: "glg-graph", width, height: ROW_HEIGHT });
        const midY = ROW_HEIGHT / 2;

        const line = (x1, y1, x2, y2, color) =>
            svgEl("line", { x1, y1, x2, y2, stroke: color, "stroke-width": 2, "stroke-linecap": "round" });

        // 切り詰めると複数のレーンが同じ x に重なるので、縦線は 1 本だけ描く
        const drawnVerticals = new Set();

        for (const index of row.passLanes) {
            const x = laneDrawX(index);
            if (drawnVerticals.has(x)) continue;
            drawnVerticals.add(x);
            svg.appendChild(line(x, 0, x, ROW_HEIGHT, laneColor(index)));
        }
        const dotX = laneDrawX(row.lane);
        if (row.hasTop) {
            svg.appendChild(line(dotX, 0, dotX, midY, laneColor(row.lane)));
        }
        if (row.hasBottom) {
            svg.appendChild(line(dotX, midY, dotX, ROW_HEIGHT, laneColor(row.lane)));
        }

        // 合流: 相手レーンの上端からドットへ。線の色は元のレーンのもの
        for (const index of row.merges) {
            const from = laneDrawX(index);
            svg.appendChild(
                svgEl("path", {
                    d: `M ${from} 0 C ${from} ${midY * 0.7}, ${dotX} ${midY * 0.3}, ${dotX} ${midY}`,
                    fill: "none",
                    stroke: laneColor(index),
                    "stroke-width": 2,
                }),
            );
        }

        // 分岐 (マージコミットの第 2 親以降): ドットから相手レーンの下端へ
        for (const index of row.branches) {
            const to = laneDrawX(index);
            svg.appendChild(
                svgEl("path", {
                    d: `M ${dotX} ${midY} C ${dotX} ${midY * 1.3}, ${to} ${midY * 1.7}, ${to} ${ROW_HEIGHT}`,
                    fill: "none",
                    stroke: laneColor(index),
                    "stroke-width": 2,
                }),
            );
        }

        const dot = svgEl("circle", {
            class: row.isMerge ? "glg-dot glg-dot-merge" : "glg-dot",
            cx: dotX,
            cy: midY,
            r: row.isMerge ? DOT_RADIUS + 0.5 : DOT_RADIUS,
        });
        // マージは中抜き、通常は塗り。片方だけ inline style で指定し、もう片方は class に任せる
        if (row.isMerge) dot.style.stroke = laneColor(row.lane);
        else dot.style.fill = laneColor(row.lane);
        svg.appendChild(dot);

        // 寄せて描いたドットは本来の位置が分からなくなるので、ツールチップでレーン番号を補う
        if (row.lane >= MAX_VISIBLE_LANES - 1 && isLaneClipped()) {
            const title = svgEl("title", {});
            title.textContent = `レーン ${row.lane + 1} (表示上限 ${MAX_VISIBLE_LANES} を超えるため右端に寄せて表示)`;
            dot.appendChild(title);
        }

        return svg;
    };

    /** 詳細パネル行を通過するレーンの縦線。高さはパネルに合わせて引き伸ばす */
    const buildDetailGraph = (row) => {
        const width = graphWidth();
        const svg = svgEl("svg", { class: "glg-graph", width, height: "100%" });
        const drawn = new Set();
        for (const index of row.activeAfter) {
            const x = laneDrawX(index);
            if (drawn.has(x)) continue;
            drawn.add(x);
            // height="100%" の rect なら、SVG を縦に伸ばしても線幅が歪まない
            svg.appendChild(
                svgEl("rect", {
                    x: x - 1,
                    y: 0,
                    width: 2,
                    height: "100%",
                    fill: laneColor(index),
                }),
            );
        }
        return svg;
    };

    // ---------------------------------------------------------------------
    // 詳細パネル
    // ---------------------------------------------------------------------

    const diffBadge = (file) => {
        if (file.new_file) return { label: "A", className: "glg-badge glg-badge-a" };
        if (file.deleted_file) return { label: "D", className: "glg-badge glg-badge-d" };
        if (file.renamed_file) return { label: "R", className: "glg-badge glg-badge-r" };
        return { label: "M", className: "glg-badge" };
    };

    const buildMetaRow = (panel, key, valueNode) => {
        panel.appendChild(el("div", "glg-detail-key", key));
        const value = el("div", "glg-detail-value");
        value.appendChild(valueNode);
        panel.appendChild(value);
    };

    const buildDetailPanel = (row, payload) => {
        const panel = el("div", "glg-detail-panel");

        if (payload.error) {
            panel.appendChild(el("div", "glg-detail-error", `コミット詳細の取得に失敗した (${payload.error})`));
            return panel;
        }
        if (!payload.detail) {
            panel.appendChild(el("div", "glg-detail-note", "読み込み中…"));
            return panel;
        }

        const detail = payload.detail;

        panel.appendChild(el("pre", "glg-detail-message", detail.message ?? row.commit.title));

        const meta = el("div", "glg-detail-meta");
        const authorText = detail.author_email
            ? `${detail.author_name ?? ""} <${detail.author_email}>`
            : (detail.author_name ?? "");
        buildMetaRow(meta, "Author", document.createTextNode(`${authorText} · ${formatDateTime(detail.authored_date)}`));

        // committer が author と違うときだけ併記する (cherry-pick や web IDE のコミットで食い違う)
        const committerDiffers =
            (detail.committer_name ?? "") !== (detail.author_name ?? "") ||
            (detail.committer_email ?? "") !== (detail.author_email ?? "");
        if (committerDiffers) {
            const committerText = detail.committer_email
                ? `${detail.committer_name ?? ""} <${detail.committer_email}>`
                : (detail.committer_name ?? "");
            buildMetaRow(
                meta,
                "Committer",
                document.createTextNode(`${committerText} · ${formatDateTime(detail.committed_date)}`),
            );
        }

        buildMetaRow(meta, "Commit", el("code", "glg-sha", detail.id ?? row.sha));

        const parents = Array.isArray(detail.parent_ids) ? detail.parent_ids : row.commit.parents;
        if (parents.length > 0) {
            const wrap = el("span");
            for (const parent of parents) {
                if (state.rowsBySha.has(parent)) {
                    const button = el("button", "glg-parent-link", parent.slice(0, 8));
                    button.type = "button";
                    button.addEventListener("click", () => {
                        selectSha(parent, true);
                    });
                    wrap.appendChild(button);
                    continue;
                }
                // ウィンドウ外の親はジャンプ先が無いので、GitLab のコミットページへ逃がす
                const link = el("a", "glg-parent-link", parent.slice(0, 8));
                link.href = `${location.origin}/${state.projectPath}/-/commit/${parent}`;
                link.target = "_blank";
                link.rel = "noopener";
                wrap.appendChild(link);
            }
            buildMetaRow(meta, "Parents", wrap);
        }

        if (detail.stats) {
            const wrap = el("span");
            wrap.appendChild(el("span", "glg-stat-added", `+${detail.stats.additions ?? 0}`));
            wrap.appendChild(document.createTextNode(" "));
            wrap.appendChild(el("span", "glg-stat-removed", `−${detail.stats.deletions ?? 0}`));
            buildMetaRow(meta, "Stats", wrap);
        }

        panel.appendChild(meta);

        if (payload.diffError) {
            panel.appendChild(el("div", "glg-detail-error", `変更ファイルの取得に失敗した (${payload.diffError})`));
        } else if (Array.isArray(payload.diff)) {
            const list = el("ul", "glg-files");
            for (const file of payload.diff) {
                const item = el("li", "glg-file");
                const badge = diffBadge(file);
                item.appendChild(el("span", badge.className, badge.label));
                const path = file.renamed_file
                    ? `${file.old_path} → ${file.new_path}`
                    : (file.new_path ?? file.old_path ?? "");
                item.appendChild(el("span", "glg-path", path));
                list.appendChild(item);
            }
            if (payload.diff.length === 0) {
                list.appendChild(el("li", "glg-detail-note", "変更ファイルなし"));
            }
            panel.appendChild(list);
            if (payload.truncated) {
                panel.appendChild(
                    el("div", "glg-detail-note", `変更ファイルは先頭 ${DIFF_LIMIT} 件のみ表示。以降省略`),
                );
            }
        }

        const actions = el("div", "glg-detail-actions");
        const open = el("a", null, "GitLab で開く");
        open.href = commitWebUrl(row.commit);
        open.target = "_blank";
        open.rel = "noopener";
        actions.appendChild(open);
        panel.appendChild(actions);

        return panel;
    };

    const buildDetailRow = (row, payload) => {
        const tr = el("tr", "glg-detail-row");
        const graphCell = el("td", "glg-cell-graph-detail");
        graphCell.appendChild(buildDetailGraph(row));
        const cell = el("td", "glg-detail-cell");
        cell.colSpan = 4;
        cell.appendChild(buildDetailPanel(row, payload));
        tr.append(graphCell, cell);
        return tr;
    };

    const renderDetail = () => {
        const existing = ui.tbody.querySelector(".glg-detail-row");
        if (existing) existing.remove();
        if (!state.expandedSha) return;

        const rowEl = ui.tbody.querySelector(`.glg-row[${SHA_ATTR}="${CSS.escape(state.expandedSha)}"]`);
        const row = state.rowsBySha.get(state.expandedSha);
        if (!rowEl || !row) return;

        const payload = state.detailCache.get(state.expandedSha) ?? {};
        rowEl.insertAdjacentElement("afterend", buildDetailRow(row, payload));
    };

    const loadDetail = async (sha) => {
        if (state.detailCache.has(sha)) {
            renderDetail();
            return;
        }

        state.detailToken += 1;
        const token = state.detailToken;
        renderDetail();

        const payload = {};
        const [detailResult, diffResult] = await Promise.allSettled([fetchCommitDetail(sha), fetchCommitDiff(sha)]);

        if (detailResult.status === "fulfilled") payload.detail = detailResult.value;
        else payload.error = describeError(detailResult.reason);

        if (diffResult.status === "fulfilled") {
            payload.diff = Array.isArray(diffResult.value) ? diffResult.value : [];
            payload.truncated = payload.diff.length >= DIFF_LIMIT;
        } else {
            payload.diffError = describeError(diffResult.reason);
        }

        state.detailCache.set(sha, payload);
        // 応答を待つ間に別の行を開いていたら、この結果は描かない
        if (token !== state.detailToken || state.expandedSha !== sha) return;
        renderDetail();
    };

    const toggleDetail = (sha) => {
        if (!sha) return;
        if (state.expandedSha === sha) {
            state.expandedSha = "";
            renderDetail();
            return;
        }
        // 開けるのは常に 1 つ。別の行を開いたら差し替える
        state.expandedSha = sha;
        void loadDetail(sha);
    };

    // ---------------------------------------------------------------------
    // テーブル描画
    // ---------------------------------------------------------------------

    const matchesFilter = (row, needle) => {
        if (!needle) return true;
        const commit = row.commit;
        return (
            commit.title.toLowerCase().includes(needle) ||
            commit.authorName.toLowerCase().includes(needle) ||
            commit.sha.toLowerCase().includes(needle)
        );
    };

    const buildDescCell = (row) => {
        const td = el("td", "glg-cell-desc");
        const inner = el("div", "glg-desc-inner");

        for (const ref of state.refsBySha.get(row.sha) ?? []) {
            const isTag = ref.type === "tag";
            const className = isTag
                ? "glg-chip glg-chip-tag"
                : ref.isDefault
                  ? "glg-chip glg-chip-default"
                  : "glg-chip";
            const chip = el("span", className, ref.name);
            chip.title = isTag ? `タグ: ${ref.name}` : `ブランチ: ${ref.name}`;
            // ブランチのチップだけレーン色で縁取り、どの線の先端かを見分けられるようにする
            if (!isTag) chip.style.borderColor = laneColor(row.lane);
            inner.appendChild(chip);
        }

        const title = el("span", "glg-title", row.commit.title);
        title.title = row.commit.title;
        inner.appendChild(title);

        td.appendChild(inner);
        return td;
    };

    const buildRow = (row) => {
        const tr = el("tr", "glg-row");
        tr.setAttribute(SHA_ATTR, row.sha);

        const graphCell = el("td", "glg-cell-graph");
        const graph = buildRowGraph(row);
        // フィルタ中は表示行が飛ぶのでレーンの線が繋がらない。誤読を防ぐため薄く描く
        if (state.filter) graph.classList.add("glg-graph-dimmed");
        graphCell.appendChild(graph);

        const author = el("td", "glg-author", row.commit.authorName);
        author.title = row.commit.authorName;

        const date = el("td", "glg-date", formatDateTime(row.commit.committedDate));
        const sha = el("td", "glg-sha", row.commit.shortSha);
        sha.title = row.sha;

        tr.append(graphCell, buildDescCell(row), author, date, sha);
        return tr;
    };

    const updateSelectionUi = () => {
        for (const node of ui.tbody.querySelectorAll(`.glg-row[${SELECTED_ATTR}]`)) {
            node.removeAttribute(SELECTED_ATTR);
        }
        if (!state.selectedSha) return;
        const rowEl = ui.tbody.querySelector(`.glg-row[${SHA_ATTR}="${CSS.escape(state.selectedSha)}"]`);
        if (rowEl) rowEl.setAttribute(SELECTED_ATTR, "");
    };

    const scrollToSelected = () => {
        if (!state.selectedSha) return;
        const rowEl = ui.tbody.querySelector(`.glg-row[${SHA_ATTR}="${CSS.escape(state.selectedSha)}"]`);
        if (!rowEl) return;

        // 移動のたびに中央寄せするとビューポートが毎回跳ねて追いにくい。
        // 上下に余白を残して画面内に収まっている間はスクロールしない (vim の scrolloff に近い挙動)
        const rect = rowEl.getBoundingClientRect();
        const comfortable = rect.top >= SCROLL_MARGIN_PX && rect.bottom <= window.innerHeight - SCROLL_MARGIN_PX;
        if (!comfortable) rowEl.scrollIntoView({ block: "center" });
    };

    const renderStatus = () => {
        ui.status.textContent = "";
        if (state.statusText) ui.status.appendChild(el("div", null, state.statusText));
        if (state.notice) ui.status.appendChild(el("div", "glg-status-note", state.notice));
        for (const entry of state.errors) ui.status.appendChild(el("div", "glg-status-error", entry.message));
    };

    const renderCount = () => {
        // どのスコープの件数なのかを併記する。
        // 取得に失敗した 0 件を「(全件)」と表示すると、成功して 0 件だったのと見分けが付かない
        const scope = state.mode === "ref" ? state.refName : "全ブランチ";
        const complete = !state.hasMore && state.commits.length > 0 && !hasError("commits");
        ui.countLabel.textContent = `${scope}: 表示 ${state.visibleRows.length} 件 / 読み込み済み ${state.commits.length} 件${
            complete ? " (全件)" : ""
        }`;
        ui.moreButton.disabled = state.loading || !state.hasMore;
        ui.moreButton.textContent = state.loading ? "読み込み中…" : "さらに読み込む";
    };

    /** グラフ列の幅と「隠れているレーン数」の表示を、現在のレーン数に合わせて更新する */
    const renderGraphColumn = () => {
        ui.graphCol.style.width = `${graphWidth()}px`;
        ui.root.classList.toggle("glg-clipped", isLaneClipped());

        ui.graphHead.textContent = "Graph";
        if (!isLaneClipped()) {
            ui.graphHead.removeAttribute("title");
            return;
        }
        const more = el("span", "glg-head-graph-more", ` (+${hiddenLaneCount()})`);
        ui.graphHead.appendChild(more);
        ui.graphHead.title = `同時に ${state.laneCount} 本のレーンがある。右の ${hiddenLaneCount()} 本は最右のレーンに寄せて表示している`;
    };

    const renderTable = () => {
        const needle = state.filter.trim().toLowerCase();
        state.visibleRows = state.graphRows.filter((row) => matchesFilter(row, needle));

        renderGraphColumn();
        ui.tbody.textContent = "";

        for (const row of state.visibleRows) ui.tbody.appendChild(buildRow(row));

        if (state.visibleRows.length === 0) {
            const tr = el("tr");
            const td = el("td", "glg-empty", state.loading ? "読み込み中…" : "表示できるコミットがない");
            td.colSpan = 5;
            tr.appendChild(td);
            ui.tbody.appendChild(tr);
        }

        // 選択と展開は sha で持っているので、再描画で消えても復元できる
        const visibleShas = new Set(state.visibleRows.map((row) => row.sha));
        if (state.selectedSha && !visibleShas.has(state.selectedSha)) state.selectedSha = "";
        if (!state.selectedSha && state.visibleRows.length > 0) state.selectedSha = state.visibleRows[0].sha;
        if (state.expandedSha && !visibleShas.has(state.expandedSha)) state.expandedSha = "";

        updateSelectionUi();
        renderDetail();
        renderCount();
        renderStatus();
    };

    const selectSha = (sha, scroll) => {
        if (!state.rowsBySha.has(sha)) return;
        // フィルタで隠れている行へは飛べないので、フィルタを解除してから選ぶ
        if (!state.visibleRows.some((row) => row.sha === sha)) {
            state.filter = "";
            ui.filterInput.value = "";
            renderTable();
        }
        state.selectedSha = sha;
        updateSelectionUi();
        if (scroll) scrollToSelected();
    };

    const moveSelection = (delta) => {
        if (state.visibleRows.length === 0) return false;
        const current = state.visibleRows.findIndex((row) => row.sha === state.selectedSha);
        const next = current === -1 ? 0 : Math.min(Math.max(current + delta, 0), state.visibleRows.length - 1);
        state.selectedSha = state.visibleRows[next].sha;
        updateSelectionUi();
        scrollToSelected();
        return true;
    };

    // ---------------------------------------------------------------------
    // データロード
    // ---------------------------------------------------------------------

    const rebuildGraph = () => {
        const ordered = topoSortCommits(state.commits);
        const result = assignLanes(ordered);
        state.graphRows = result.rows;
        state.laneCount = result.laneCount;
        state.rowsBySha = new Map(result.rows.map((row) => [row.sha, row]));
    };

    const rebuildRefs = () => {
        const map = new Map();
        const push = (sha, entry) => {
            if (!sha) return;
            const list = map.get(sha);
            if (list) list.push(entry);
            else map.set(sha, [entry]);
        };
        for (const branch of state.branches) {
            push(branch.commit?.id, {
                type: "branch",
                name: branch.name,
                isDefault: Boolean(branch.default) || branch.name === state.defaultBranch,
            });
        }
        for (const tag of state.tags) {
            push(tag.commit?.id, { type: "tag", name: tag.name, isDefault: false });
        }
        // default branch を先頭、その後ブランチ、最後にタグ
        for (const list of map.values()) {
            list.sort((a, b) => {
                if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
                if (a.type !== b.type) return a.type === "branch" ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
        }
        state.refsBySha = map;
    };

    const appendCommits = (payload) => {
        if (!Array.isArray(payload)) return 0;
        let added = 0;
        for (const raw of payload) {
            const commit = normalizeCommit(raw);
            if (!commit.sha) continue;
            // 日時窓の境界にいるコミットは前後の窓の両方に現れるので sha で弾く
            if (state.loadedShas.has(commit.sha)) continue;
            state.loadedShas.add(commit.sha);
            state.commits.push(commit);
            added += 1;
        }
        return added;
    };

    /** ロード済みウィンドウ内で最も古い committed_date。次の窓の until に使う */
    const oldestLoadedDate = () => {
        let oldest = null;
        for (const commit of state.commits) {
            if (!commit.committedDate) continue;
            if (oldest === null || commit.time < oldest.time) oldest = commit;
        }
        return oldest ? oldest.committedDate : "";
    };

    /** 全ブランチモードなら日時窓を、ref_name モードならページを batchCount 回ぶん直列に進める */
    const loadCommits = async (batchCount) => {
        state.loading = true;
        state.notice = "";
        renderCount();

        try {
            for (let i = 0; i < batchCount; i += 1) {
                if (!state.hasMore) break;
                const payload = await fetchCommitBatch();
                const received = Array.isArray(payload) ? payload.length : 0;
                const added = appendCommits(payload);

                if (state.mode === "ref") {
                    state.nextPage += 1;
                    if (received < PER_PAGE) {
                        state.hasMore = false;
                        break;
                    }
                    continue;
                }

                // 新規 sha が 1 件も無い = 窓が前へ進んでいない。
                // 同一日時に per_page 件を超えるコミットが固まっているとここで止まる
                if (added === 0) {
                    state.hasMore = false;
                    state.notice = `これ以上さかのぼれなかった (同じ日時に ${PER_PAGE} 件を超えるコミットが固まっている可能性)`;
                    break;
                }
                if (received < PER_PAGE) {
                    state.hasMore = false;
                    break;
                }
                state.until = oldestLoadedDate();
            }
        } catch (error) {
            pushError("commits", `コミットの取得に失敗した (${describeError(error)})`);
            state.hasMore = false;
        } finally {
            state.loading = false;
            state.statusText = "";
        }

        // 存在しない ref_name に対して、GitLab は 404 ではなく空配列を返すことがある。
        // その場合エラーが 1 つも積まれないまま 0 行になり、綴り間違いに気づけないので明示する
        if (state.mode === "ref" && state.commits.length === 0 && !hasError("commits")) {
            pushError(
                "commits",
                `ブランチ "${state.refName}" のコミットが 0 件だった (ブランチ名が正しいか、アクセス権があるか確認)`,
            );
        }

        rebuildGraph();
        renderTable();
    };

    const resetCommits = () => {
        state.commits = [];
        state.loadedShas = new Set();
        state.nextPage = 1;
        state.until = "";
        state.hasMore = true;
        state.notice = "";
        state.graphRows = [];
        state.rowsBySha = new Map();
        state.selectedSha = "";
        state.expandedSha = "";
        // 消すのはコミット取得のエラーだけ。プロジェクト情報や ref 一覧のエラーは残す
        clearErrors("commits");
    };

    const reload = async () => {
        resetCommits();
        state.statusText = "読み込み中…";
        renderTable();
        await loadCommits(INITIAL_BATCHES);
    };

    const loadRefs = async () => {
        clearErrors("refs");
        const [branchResult, tagResult] = await Promise.allSettled([fetchBranches("", undefined), fetchTags()]);

        if (branchResult.status === "fulfilled" && Array.isArray(branchResult.value)) {
            state.branches = branchResult.value;
            state.branchOptions = state.branches.map((branch) => branch.name).filter(Boolean);
        } else if (branchResult.status === "rejected") {
            pushError("refs", `ブランチ一覧の取得に失敗した (${describeError(branchResult.reason)})`);
        }

        if (tagResult.status === "fulfilled" && Array.isArray(tagResult.value)) {
            state.tags = tagResult.value;
        } else if (tagResult.status === "rejected") {
            pushError("refs", `タグ一覧の取得に失敗した (${describeError(tagResult.reason)})`);
        }

        rebuildRefs();
        renderBranchOptions();
        // ref 一覧はコミット取得と並行で解決するので、遅れて届いた場合もチップを描き直す
        renderTable();
    };

    const bootstrapData = async () => {
        state.statusText = "読み込み中…";
        renderStatus();

        try {
            const project = await fetchProject();
            state.defaultBranch = project?.default_branch ?? "";
            if (!state.ref) state.ref = state.defaultBranch;
        } catch (error) {
            pushError("project", `プロジェクト情報の取得に失敗した (${describeError(error)})。private なら要ログイン`);
        }
        renderRefLabel();

        await Promise.all([loadRefs(), reload()]);
    };

    // ---------------------------------------------------------------------
    // ツールバーとページ乗っ取り
    // ---------------------------------------------------------------------

    // branches API はアルファベット順でしか返らず sort パラメータも無い。
    // ブランチが数千あるリポジトリでは 1 ページ目が "10-0-stable" 系で埋まり、
    // default branch すら候補に出てこない (2026-08-01 に gitlab-org/gitlab-foss で確認)。
    // そのため候補は datalist にし、入力を search に渡してサーバ側で絞り込む。
    // default branch と URL の ref は候補から漏れないよう常に先頭へピン留めする
    const branchCandidates = () => {
        const names = [];
        const seen = new Set();
        const push = (name) => {
            if (!name || seen.has(name)) return;
            seen.add(name);
            names.push(name);
        };
        push(state.defaultBranch);
        push(state.ref);
        for (const name of state.branchOptions) push(name);
        return names;
    };

    const renderBranchOptions = () => {
        ui.branchList.textContent = "";
        for (const name of branchCandidates()) ui.branchList.appendChild(new Option(name, name));
    };

    /** 入力中は候補だけを更新する。コミット一覧の再取得は確定時にしか走らせない */
    const runBranchSearch = async () => {
        const term = ui.branchInput.value.trim();
        if (branchSearchController) branchSearchController.abort();
        const controller = new AbortController();
        branchSearchController = controller;

        clearErrors("branch-search");
        try {
            const payload = await fetchBranches(term, controller.signal);
            // 応答を待つ間に次の検索が始まっていたら、この結果は捨てる
            if (controller !== branchSearchController) return;
            if (Array.isArray(payload)) {
                state.branchOptions = payload.map((branch) => branch.name).filter(Boolean);
                renderBranchOptions();
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            pushError("branch-search", `ブランチ候補の取得に失敗した (${describeError(error)})`);
            renderStatus();
        }
    };

    const scheduleBranchSearch = () => {
        clearTimeout(branchSearchTimer);
        branchSearchTimer = setTimeout(() => {
            void runBranchSearch();
        }, BRANCH_SEARCH_DEBOUNCE_MS);
    };

    /** 入力値を確定してモードを切り替える。空なら全ブランチ */
    const commitBranchSelection = () => {
        const value = ui.branchInput.value.trim();
        // 確定したらフォーカスを外す。入力欄に残っていると、続けて押した j/k が
        // ブランチ名の続きとして入力されてしまう
        ui.branchInput.blur();
        const nextMode = value ? "ref" : "all";
        // 同じ選択での再確定 (blur による change など) では取り直さない
        if (nextMode === state.mode && (nextMode === "all" || value === state.refName)) return;
        state.mode = nextMode;
        state.refName = value;
        // 存在しないブランチ名なら commits API が失敗する。エラーはそのまま表示に出す
        void reload();
    };

    const renderRefLabel = () => {
        ui.refLabel.textContent = state.ref ? `ref: ${state.ref}` : "";
    };

    const setNativeMode = (native) => {
        state.nativeMode = native;
        if (state.nativeRoot) state.nativeRoot.classList.toggle("glg-hidden", !native);
        ui.root.classList.toggle("glg-hidden", native);
        ui.nativeButton.textContent = native ? "Git Graph 表示に戻す" : "ネイティブ表示に戻す";
    };

    const buildUi = (nativeRoot) => {
        const root = el("div", "glg-root");

        const toolbar = el("div", "glg-toolbar");

        const branchInput = el("input", "glg-branch");
        branchInput.type = "text";
        branchInput.spellcheck = false;
        branchInput.placeholder = "全ブランチ (入力でブランチを検索)";
        branchInput.title = "空なら全ブランチ。ブランチ名を確定するとそのブランチだけを表示する";
        const branchList = document.createElement("datalist");
        branchList.id = "glg-branch-list";
        branchInput.setAttribute("list", branchList.id);
        branchInput.addEventListener("input", scheduleBranchSearch);
        // datalist から候補を選んだときと、編集後に blur したときに change が飛ぶ
        branchInput.addEventListener("change", commitBranchSelection);
        branchInput.addEventListener("keydown", (e) => {
            // 変換確定の Enter を「ブランチ確定」に化けさせない
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key !== "Enter") return;
            commitBranchSelection();
            e.preventDefault();
            e.stopPropagation();
        });

        const filterInput = el("input", "glg-filter");
        filterInput.type = "text";
        filterInput.autocomplete = "off";
        filterInput.spellcheck = false;
        filterInput.placeholder = "フィルタ (タイトル / 作者 / SHA)";
        filterInput.addEventListener("input", () => {
            state.filter = filterInput.value;
            renderTable();
        });

        const moreButton = el("button", "glg-more", "さらに読み込む");
        moreButton.type = "button";
        moreButton.addEventListener("click", () => {
            void loadCommits(1);
        });

        const countLabel = el("span", "glg-count");
        const refLabel = el("span", "glg-ref-label");

        const nativeButton = el("button", "glg-native", "ネイティブ表示に戻す");
        nativeButton.type = "button";
        nativeButton.addEventListener("click", () => {
            setNativeMode(!state.nativeMode);
        });

        toolbar.append(
            branchInput,
            branchList,
            filterInput,
            moreButton,
            countLabel,
            refLabel,
            el("span", "glg-spacer"),
            nativeButton,
        );

        const status = el("div", "glg-status");

        const wrap = el("div", "glg-table-wrap");
        const table = el("table", "glg-table");

        // Graph 列だけ再描画のたびに px を書き換える。Description 列は幅を指定せず残り全部を取らせる
        const colgroup = document.createElement("colgroup");
        const graphCol = document.createElement("col");
        graphCol.style.width = `${graphWidth()}px`;
        const descCol = document.createElement("col");
        const authorCol = document.createElement("col");
        authorCol.style.width = "160px";
        const dateCol = document.createElement("col");
        dateCol.style.width = "130px";
        const shaCol = document.createElement("col");
        shaCol.style.width = "86px";
        colgroup.append(graphCol, descCol, authorCol, dateCol, shaCol);

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        const graphHead = el("th", "glg-head-graph", "Graph");
        headRow.appendChild(graphHead);
        for (const label of ["Description", "Author", "Date", "SHA"]) {
            headRow.appendChild(el("th", null, label));
        }
        thead.appendChild(headRow);

        const tbody = document.createElement("tbody");
        tbody.addEventListener("click", (e) => {
            const target = e.target instanceof Element ? e.target.closest(".glg-row") : null;
            if (!target) return;
            const sha = target.getAttribute(SHA_ATTR);
            if (!sha) return;
            state.selectedSha = sha;
            updateSelectionUi();
            toggleDetail(sha);
        });

        table.append(colgroup, thead, tbody);
        wrap.appendChild(table);
        root.append(toolbar, status, wrap);

        // ネイティブのグラフは削除せず隠すだけにして、いつでも戻せるようにする
        nativeRoot.classList.add("glg-hidden");
        nativeRoot.insertAdjacentElement("afterend", root);

        ui.root = root;
        ui.status = status;
        ui.branchInput = branchInput;
        ui.branchList = branchList;
        ui.filterInput = filterInput;
        ui.moreButton = moreButton;
        ui.countLabel = countLabel;
        ui.refLabel = refLabel;
        ui.nativeButton = nativeButton;
        ui.graphCol = graphCol;
        ui.graphHead = graphHead;
        ui.tbody = tbody;

        state.nativeRoot = nativeRoot;
        renderBranchOptions();
        renderRefLabel();
        renderCount();
    };

    /** Vue の描画完了を待つ。タイムアウトしたら null を返し、ページには触れない */
    const waitForNativeRoot = () =>
        new Promise((resolve) => {
            const found = document.querySelector(NATIVE_ROOT_SELECTOR);
            if (found) {
                resolve(found);
                return;
            }
            let timer = 0;
            const observer = new MutationObserver(() => {
                const node = document.querySelector(NATIVE_ROOT_SELECTOR);
                if (!node) return;
                observer.disconnect();
                clearTimeout(timer);
                resolve(node);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            timer = setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, NATIVE_WAIT_MS);
        });

    /** URL からプロジェクトのフルパスと ref を取り出す。ネットワークページ以外なら null */
    const parseContext = () => {
        const pathname = location.pathname;
        const marker = "/-/network";
        const markerIndex = pathname.indexOf(marker);
        if (markerIndex === -1) return null;

        // "/-/" より前がプロジェクトのフルパス。サブグループがあるので階層数を固定で仮定しない
        const projectPath = pathname.slice(0, markerIndex).replace(/^\/+/, "").replace(/\/+$/, "");
        if (!projectPath.includes("/")) return null;

        // ref はブランチ名にスラッシュが含まれ得るので split せず、残り全部を 1 つの名前として扱う
        const rest = pathname.slice(markerIndex + marker.length).replace(/^\/+/, "").replace(/\/+$/, "");
        let ref = "";
        try {
            ref = decodeURIComponent(rest);
        } catch {
            ref = rest;
        }

        return { projectPath, ref };
    };

    // ---------------------------------------------------------------------
    // キーハンドラ
    // ---------------------------------------------------------------------

    const isEditableTarget = (target) => {
        if (!(target instanceof Element)) return false;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        if (target instanceof HTMLElement && target.isContentEditable) return true;
        return false;
    };

    const isActive = () => Boolean(ui.root) && !state.nativeMode && ui.root.isConnected;

    const openSelectedCommit = () => {
        const row = state.rowsBySha.get(state.selectedSha);
        if (!row) return false;
        window.open(commitWebUrl(row.commit), "_blank", "noopener");
        return true;
    };

    const copySelectedSha = async () => {
        if (!state.selectedSha) return;
        try {
            await navigator.clipboard.writeText(state.selectedSha);
            showToast(`コピーした: ${state.selectedSha}`);
        } catch (error) {
            showToast(`コピーに失敗した: ${error?.message ?? "不明なエラー"}`);
        }
    };

    const onKeyDown = (e) => {
        // IME 変換中の keydown をキーバインドとして扱うと、日本語入力が「j で下移動」等に化ける。
        // keyCode === 229 は isComposing を正しく立てない環境向けのフォールバック。
        if (e.isComposing || e.keyCode === 229) return;

        // ブラウザ/GitLab 側のショートカットを奪わない
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        if (!isActive()) return;

        // 編集対象では一切横取りしない。自前の入力欄での Esc だけ blur に使う
        if (isEditableTarget(e.target)) {
            const ownInput = e.target === ui.filterInput || e.target === ui.branchInput;
            if (ownInput && e.key === "Escape") {
                e.target.blur();
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }

        const key = e.key;
        const now = Date.now();
        const waitingSecondKey = pendingYAt !== 0 && now - pendingYAt <= Y_SEQUENCE_MS;
        pendingYAt = 0;

        if (waitingSecondKey && key === "y") {
            void copySelectedSha();
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (key === "y") {
            // 1 打目の y には他の割り当てが無いので、2 打目を待つあいだ握りつぶしてよい
            pendingYAt = now;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        let handled = false;
        switch (key) {
            case "j":
                handled = moveSelection(1);
                break;
            case "k":
                handled = moveSelection(-1);
                break;
            case "Enter":
                if (state.selectedSha) {
                    toggleDetail(state.selectedSha);
                    handled = true;
                }
                break;
            case "o":
                handled = openSelectedCommit();
                break;
            case "/":
                ui.filterInput.focus();
                ui.filterInput.select();
                handled = true;
                break;
            case "Escape":
                if (state.expandedSha) {
                    state.expandedSha = "";
                    renderDetail();
                    handled = true;
                }
                break;
            case "l":
                if (state.hasMore && !state.loading) {
                    void loadCommits(1);
                    handled = true;
                }
                break;
            default:
                return;
        }

        // 処理しなかったキーは GitLab 側にそのまま渡す
        if (!handled) return;

        e.preventDefault();
        e.stopPropagation();
    };

    // ---------------------------------------------------------------------
    // 起動
    // ---------------------------------------------------------------------

    const main = async () => {
        const context = parseContext();
        // ネットワークページ以外では DOM に一切触らない
        if (!context) return;

        state.projectPath = context.projectPath;
        state.ref = context.ref;

        injectStyle();

        const nativeRoot = await waitForNativeRoot();
        // 描画されなかったときはネイティブ表示のまま放置する
        if (!nativeRoot) return;

        buildUi(nativeRoot);
        // GitLab 自身のキーハンドラより先に受けたいのでキャプチャフェーズで登録する
        document.addEventListener("keydown", onKeyDown, true);

        await bootstrapData();
    };

    void main();
})();
