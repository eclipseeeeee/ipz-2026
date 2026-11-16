"""Незалежна перевірка розрахунків застосунку «Кімната 3D» (додаток Б).

Скрипт читає контрольну сцену demo-project.json і перераховує за формулами
звіту: площі стін, листи ГКЛ (оцінка за площею), профілі стелі, плінтуси та
довжину проводів за ортогональними маршрутами. Код застосунку не
використовується, тому збіг із виводом вкладки «Розрахунки» є незалежним
підтвердженням коректності. Запуск: python verify_calc.py
"""
import json
import math
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8")  # кирилиця у консолі Windows


def round2(v):
    """Math.round(v * 100) / 100 як у JavaScript (півцілі — вгору)."""
    return math.floor(v * 100 + 0.5) / 100


here = pathlib.Path(__file__).parent
data = json.loads((here / "demo-project.json").read_text(encoding="utf-8"))
rooms = {r["id"]: r for r in data["rooms"]}

# Параметри за замовчуванням, як у формах вкладки «Розрахунки»
SW, SH, WASTE = 1.2, 2.5, 10      # лист ГКЛ, відходи, %
RAIL_STEP, RAIL_STOCK = 0.6, 3.0  # крок CD, довжина профілю
PL_PIECE, PL_WASTE = 2.5, 5       # плінтус: планка, запас, %
SLACK = 15                        # запас проводки, %


def wall_len(room, wall):
    return room["width"] if wall in ("north", "south") else room["length"]


# ---------- 1. Площі стін ----------
tot_gross = tot_doors = tot_net = 0.0
for r in rooms.values():
    w, l, h = r["width"], r["length"], r["height"]
    gross = round2(2 * (w + l) * h)
    doors = round2(sum(d["width"] * d["height"] for d in data["doors"] if d["room"] == r["id"]))
    net = round2(2 * (w + l) * h - sum(d["width"] * d["height"] for d in data["doors"] if d["room"] == r["id"]))
    tot_gross += gross
    tot_doors += doors
    tot_net += net
    print(f"{r['name']}: стіни {gross:.2f}, прорізи {doors:.2f}, чиста {net:.2f} м2")
tot_gross, tot_doors, tot_net = round2(tot_gross), round2(tot_doors), round2(tot_net)
print(f"Разом: стіни {tot_gross:.2f}, прорізи {tot_doors:.2f}, чиста {tot_net:.2f} м2")

# ---------- 2. Гіпсокартон (оцінка за площею) ----------
reveal = sum(2 * d["reveal"] * d["height"] + d["reveal"] * d["width"]
             for d in data["doors"] if d["reveal"] > 0)
wall_area = tot_net + reveal
sheets = math.ceil(wall_area * (1 + WASTE / 100) / (SW * SH))
print(f"ГКЛ: відкоси {reveal:.2f} м2, площа {wall_area:.2f} м2, листів {sheets}")

# ---------- 3. Профілі стелі ----------
ud = cd = hangers = crabs = 0
for r in rooms.values():
    w, l = r["width"], r["length"]
    ud += 2 * (w + l)
    rows = math.floor(l / RAIL_STEP) + 1
    cd += rows * w
    hangers += rows * (math.floor(w / 0.6) + 1)
    crabs += rows * (math.floor(w / RAIL_STEP) + 1)
print(f"Профілі: UD {ud:.2f} м ({math.ceil(ud / RAIL_STOCK)} шт), "
      f"CD {cd:.2f} м ({math.ceil(cd / RAIL_STOCK)} шт), підвіси {hangers}, краби {crabs}")

# ---------- 4. Плінтуси ----------
perimeter = sum(2 * (r["width"] + r["length"]) for r in rooms.values())
open_w = sum(d["width"] for d in data["doors"])
floor_len = max(0.0, perimeter - open_w)
k = 1 + PL_WASTE / 100
pf = math.ceil(floor_len * k / PL_PIECE)
pc = math.ceil(perimeter * k / PL_PIECE)
print(f"Плінтуси: периметр {perimeter:.2f}, підлоговий {floor_len:.2f} м ({pf} шт), "
      f"стельовий {perimeter:.2f} м ({pc} шт), разом {pf + pc}")

# ---------- 5. Довжина проводів ----------
T = 0.03  # виступ елемента над стіною, м
elems = {e["id"]: e for e in data["elements"]}
lights = {lt["id"]: lt for lt in data["lights"]}


def tangent_point(room, wall, along):
    cx, cz, w, l = room["x"], room["z"], room["width"], room["length"]
    if wall == "north":
        return cx - w / 2 + along, cz + l / 2, (0, 1)
    if wall == "south":
        return cx + w / 2 - along, cz - l / 2, (0, -1)
    if wall == "east":
        return cx - w / 2, cz - l / 2 + along, (-1, 0)
    return cx + w / 2, cz + l / 2 - along, (1, 0)  # west


def node(nid):
    """(x, y, z, поверхня, кімната) вузла проводки."""
    if nid in elems:
        e = elems[nid]
        r = rooms[e["room"]]
        along = wall_len(r, e["wall"]) - e["offset"] if e["side"] == "right" else e["offset"]
        x, z, (nx, nz) = tangent_point(r, e["wall"], along)
        return (x - nx * T, r["floor"] + e["elevation"], z - nz * T), ("wall", e["wall"]), r
    lt = lights[nid]
    r = rooms[lt["room"]]
    if lt["mount"] == "wall":
        along = wall_len(r, lt["wall"]) - lt["offset"] if lt["side"] == "right" else lt["offset"]
        x, z, (nx, nz) = tangent_point(r, lt["wall"], along)
        return (x - nx * 0.1, r["floor"] + lt["elevation"], z - nz * 0.1), ("wall", lt["wall"]), r
    return ((r["x"] - r["width"] / 2 + lt["x"], r["floor"] + r["height"] - 0.06,
             r["z"] - r["length"] / 2 + lt["z"]), ("ceiling",), r)


def route_length(wire):
    P, sp, rp = node(wire["from"])
    Q, sq, rq = node(wire["to"])
    d = lambda a, b: abs(a - b)
    if (not wire["ceiling"] and rp["id"] == rq["id"] and sp == sq and sp[0] == "wall"):
        return d(Q[0], P[0]) + d(Q[2], P[2]) + d(Q[1], P[1])  # «Г» на одній стіні
    cy = min(rp["floor"] + rp["height"], rq["floor"] + rq["height"]) - 0.02
    pts = [P]
    if d(P[1], cy) > 1e-4:
        pts.append((P[0], cy, P[2]))
    if d(P[0], Q[0]) > 1e-4 and d(P[2], Q[2]) > 1e-4:
        pts.append((Q[0], cy, P[2]))
    if d(Q[1], cy) > 1e-4:
        pts.append((Q[0], cy, Q[2]))
    pts.append(Q)
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


total = 0.0
for i, w in enumerate(data["wires"], 1):
    ln = route_length(w)
    total += ln
    print(f"Провід {i}: {w['from']} -> {w['to']} ({w['cable']}): {ln:.2f} м")
print(f"Сумарна довжина {total:.2f} м, із запасом {SLACK}%: {total * (1 + SLACK / 100):.2f} м")
