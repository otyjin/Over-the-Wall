/**
 * Over the Wall v2.1 — Game Engine
 * ============================================================
 * server.py의 게임 로직을 그대로 JS로 포팅.
 * UI/렌더링과 완전히 분리. 순수 함수형으로 작성.
 *
 * 주요 규칙 (규칙요약.txt 기준):
 *  - BLACK: (14,7) 시작, WHITE: (0,7) 시작
 *  - 상대 시작 칸 도달 시 승리
 *  - 매 턴 AP 3
 *  - 벽 최대 10개, 8방향 인접 불가
 *  - 벽 오라 2중첩 → 늪 (늪→늪 이동 시 2AP)
 *  - 벽 오라 3중첩 → Anchor 구역 (턴 종료 시 복귀)
 *  - 성역(시작점 맨해튼 거리≤2): 늪 면제, 내 벽 설치 불가
 */

const GRID_SIZE = 15;
const CONFIG = {
  MAX_AP: 3,
  DIAGONAL_COST: 2,
  SWAMP_MOVE_COST: 2,
  MAX_WALLS: 10,
  ANCHOR_AURA_THRESHOLD: 3,
};

const BLACK_START = [GRID_SIZE - 1, Math.floor(GRID_SIZE / 2)]; // [14, 7]
const WHITE_START = [0, Math.floor(GRID_SIZE / 2)];              // [0,  7]

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function opp(p) { return p === "BLACK" ? "WHITE" : "BLACK"; }
function getDist(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); }
function posEq(a, b) { return a[0] === b[0] && a[1] === b[1]; }
function inBounds(x, y) { return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE; }

/** walls: { "x,y": "BLACK"|"WHITE" } */
function countAuras(x, y, owner, walls) {
  let n = 0;
  for (const [key, o] of Object.entries(walls)) {
    if (o !== owner) continue;
    const [wx, wy] = key.split(",").map(Number);
    if (Math.abs(x - wx) <= 1 && Math.abs(y - wy) <= 1) n++;
  }
  return n;
}

function isInSanctuary(pos, player) {
  const start = player === "BLACK" ? BLACK_START : WHITE_START;
  return getDist(pos, start) <= 2;
}

function isSwamp(pos, player, walls) {
  if (isInSanctuary(pos, player)) return false;
  return countAuras(pos[0], pos[1], opp(player), walls) >= 2;
}

function isAnchorZone(pos, player, walls) {
  if (isInSanctuary(pos, player)) return false;
  return countAuras(pos[0], pos[1], opp(player), walls) >= CONFIG.ANCHOR_AURA_THRESHOLD;
}

/**
 * 늪→늪 이동 시 2AP, 그 외 1AP
 * (규칙: 늪이 아닌→늪 1AP, 늪→늪이 아닌 1AP, 늪→늪 2AP)
 */
function swampCost(from, to, player, walls) {
  return (isSwamp(from, player, walls) && isSwamp(to, player, walls))
    ? CONFIG.SWAMP_MOVE_COST : 1;
}

function updateAnchor(player, from, to, walls, state) {
  const wasAnchor = isAnchorZone(from, player, walls);
  const nowAnchor = isAnchorZone(to, player, walls);
  const key = player === "BLACK" ? "black_anchor" : "white_anchor";
  if (!wasAnchor && nowAnchor) {
    state[key] = [...from];
  } else if (wasAnchor && !nowAnchor) {
    state[key] = null;
  }
}

function canPlace(x, y, player, walls, state) {
  const inv = player === "BLACK" ? state.black_inv : state.white_inv;
  if (inv <= 0) return false;
  if (!inBounds(x, y)) return false;
  if (walls[`${x},${y}`]) return false;
  // 플레이어/시작칸 불가
  if (posEq([x, y], state.black_pos)) return false;
  if (posEq([x, y], state.white_pos)) return false;
  if (posEq([x, y], BLACK_START)) return false;
  if (posEq([x, y], WHITE_START)) return false;
  // 내 성역 안 불가
  if (isInSanctuary([x, y], player)) return false;
  // Anchor 칸 불가
  const anc = player === "BLACK" ? state.black_anchor : state.white_anchor;
  if (anc && posEq([x, y], anc)) return false;
  // 내 벽끼리 8방향 인접 불가
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (walls[`${x + dx},${y + dy}`] === player) return false;
    }
  }
  return true;
}

function maybeAnchorRecall(player, walls, state) {
  const key = player === "BLACK" ? "black_anchor" : "white_anchor";
  const pkey = player === "BLACK" ? "black_pos" : "white_pos";
  const anc = state[key];
  if (anc === null) return;
  if (isAnchorZone(state[pkey], player, walls)) {
    state[pkey] = [...anc];
    state.last_msg = `${player} Anchor Recall! → [${anc}]`;
  }
  state[key] = null;
}

function doEndTurn(player, walls, state) {
  maybeAnchorRecall(player, walls, state);
  const nxt = opp(player);
  state.current_turn = nxt;
  state.actions_left = CONFIG.MAX_AP;
  // 다음 플레이어 anchor 초기화
  const nk = nxt === "BLACK" ? "black_anchor" : "white_anchor";
  state[nk] = null;
}

function checkWin(player, state) {
  if (player === "BLACK" && posEq(state.black_pos, WHITE_START)) {
    state.game_over = true; state.winner = "BLACK"; state.last_msg = "BLACK wins!";
  } else if (player === "WHITE" && posEq(state.white_pos, BLACK_START)) {
    state.game_over = true; state.winner = "WHITE"; state.last_msg = "WHITE wins!";
  }
}

// ── 메인 액션 처리 ────────────────────────────────────────────────────

/**
 * 액션을 적용하고 소모된 AP를 반환.
 * 반환값: 숫자(소모AP) | "pass" | null(불법)
 * state를 직접 수정함 (immutable 방식은 성능상 생략).
 */
function applyAction(action, player, state) {
  const walls = state.walls;
  const ap = state.actions_left;
  const blk = player === "BLACK";
  const curr = blk ? [...state.black_pos] : [...state.white_pos];
  const oppPos = blk ? [...state.white_pos] : [...state.black_pos];
  const kind = action.type;

  // ── 이동 ──────────────────────────────────────────────────────────
  if (kind === "move") {
    const { dx, dy, shift } = action;

    // 대각선 점프 (dx≠0 && dy≠0)
    if (dx !== 0 && dy !== 0) {
      const mx = curr[0] + dx, my = curr[1] + dy;
      const tx = curr[0] + dx * 2, ty = curr[1] + dy * 2;
      if (!inBounds(tx, ty)) return null;
      const midIsWall = walls[`${mx},${my}`] === player;
      const midIsOpp  = posEq([mx, my], oppPos);
      const destFree  = !walls[`${tx},${ty}`] && !posEq([tx, ty], oppPos);
      if (!(midIsWall || midIsOpp) || !destFree) return null;
      if (ap < CONFIG.DIAGONAL_COST) return null;
      const dest = [tx, ty];
      if (blk) state.black_pos = dest; else state.white_pos = dest;
      updateAnchor(player, curr, dest, walls, state);
      state.last_msg = `${player} Diagonal Jump → [${dest}]`;
      return CONFIG.DIAGONAL_COST;
    }

    const nx = curr[0] + dx, ny = curr[1] + dy;
    if (!inBounds(nx, ny)) return null;

    // 직선 점프 (shift)
    if (shift) {
      const midIsWall = walls[`${nx},${ny}`] === player;
      const midIsOpp  = posEq([nx, ny], oppPos);
      if (!midIsWall && !midIsOpp) return null;
      const jx = nx + dx, jy = ny + dy;
      if (!inBounds(jx, jy)) return null;
      const dest = [jx, jy];
      if (walls[`${jx},${jy}`] || posEq(dest, oppPos)) return null;
      const cost = swampCost(curr, dest, player, walls);
      if (ap < cost) return null;
      if (blk) state.black_pos = dest; else state.white_pos = dest;
      updateAnchor(player, curr, dest, walls, state);
      state.last_msg = `${player} Straight Jump → [${dest}] (${cost}AP)`;
      return cost;
    }

    const target = [nx, ny];

    // 밀치기
    if (posEq(target, oppPos)) {
      const px = nx + dx, py = ny + dy;
      if (!inBounds(px, py)) return null;
      if (walls[`${px},${py}`]) return null;
      const cost = swampCost(curr, target, player, walls);
      if (ap < cost) return null;
      if (blk) { state.white_pos = [px, py]; state.black_pos = target; }
      else      { state.black_pos = [px, py]; state.white_pos = target; }
      updateAnchor(player, curr, target, walls, state);
      state.last_msg = `${player} Push → [${target}] (${cost}AP)`;
      return cost;
    }

    // 일반 이동
    if (walls[`${nx},${ny}`]) return null;
    const cost = swampCost(curr, target, player, walls);
    if (ap < cost) return null;
    if (blk) state.black_pos = target; else state.white_pos = target;
    updateAnchor(player, curr, target, walls, state);
    state.last_msg = `${player} Move → [${target}] (${cost}AP)`;
    return cost;
  }

  // ── 벽 설치 ───────────────────────────────────────────────────────
  if (kind === "place") {
    if (ap < 1) return null;
    const { x, y } = action;
    if (!canPlace(x, y, player, walls, state)) return null;
    state.walls[`${x},${y}`] = player;
    if (blk) state.black_inv--; else state.white_inv--;
    state.last_msg = `${player} Placed Wall (${x},${y})`;
    return 1;
  }

  // ── 벽 회수 ───────────────────────────────────────────────────────
  if (kind === "remove") {
    const { x, y } = action;
    const key = `${x},${y}`;
    if (state.walls[key] !== player) return null;
    delete state.walls[key];
    if (blk) state.black_inv = Math.min(state.black_inv + 1, CONFIG.MAX_WALLS);
    else     state.white_inv = Math.min(state.white_inv + 1, CONFIG.MAX_WALLS);
    state.last_msg = `${player} Removed Wall (${x},${y})`;
    return 0; // 0AP 소모
  }

  // ── 턴 종료 ───────────────────────────────────────────────────────
  if (kind === "pass") {
    doEndTurn(player, walls, state);
    state.last_msg = `${player} passed → ${state.current_turn}'s turn`;
    return "pass";
  }

  return null;
}

/**
 * 게임 상태 초기화
 */
function newState() {
  return {
    black_pos:    [...BLACK_START],
    white_pos:    [...WHITE_START],
    walls:        {},
    black_inv:    CONFIG.MAX_WALLS,
    white_inv:    CONFIG.MAX_WALLS,
    actions_left: CONFIG.MAX_AP,
    current_turn: "BLACK",
    game_over:    false,
    winner:       null,
    black_anchor: null,
    white_anchor: null,
    last_msg:     "Game start! BLACK moves first.",
  };
}

/**
 * 외부에서 호출하는 메인 진입점.
 * state를 직접 변이 + 결과를 반환.
 * 반환: { ok: bool, msg: string }
 */
function processAction(action, state) {
  if (state.game_over) return { ok: false, msg: "Game already over" };

  const player = state.current_turn;
  const result = applyAction(action, player, state);

  if (result === null) return { ok: false, msg: "Illegal action" };

  if (result !== "pass") {
    checkWin(player, state);
    if (!state.game_over) {
      state.actions_left -= result;
      if (state.actions_left <= 0) {
        doEndTurn(player, state.walls, state);
      }
    }
  }

  return { ok: true, msg: state.last_msg };
}

// ── 쿼리 헬퍼 (UI에서 사용) ──────────────────────────────────────────

/** 특정 셀의 아우라 정보 반환 */
function getCellAuras(x, y, walls) {
  return {
    black: countAuras(x, y, "BLACK", walls),
    white: countAuras(x, y, "WHITE", walls),
  };
}

/** 셀이 player 기준으로 늪인지 */
function cellIsSwamp(x, y, player, walls) {
  return isSwamp([x, y], player, walls);
}

/** 셀이 player 기준으로 anchor zone인지 */
function cellIsAnchorZone(x, y, player, walls) {
  return isAnchorZone([x, y], player, walls);
}

/** 셀이 player의 성역인지 */
function cellIsSanctuary(x, y, player) {
  return isInSanctuary([x, y], player);
}

// 브라우저/Node 양쪽 지원
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    GRID_SIZE, CONFIG, BLACK_START, WHITE_START,
    newState, processAction, canPlace,
    getCellAuras, cellIsSwamp, cellIsAnchorZone, cellIsSanctuary,
    opp, getDist, posEq, inBounds,
  };
}
