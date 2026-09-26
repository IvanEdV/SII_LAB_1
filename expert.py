import os
import re
from flask import Flask, request, jsonify, send_from_directory, abort, render_template

RULES_FILE = "rules.txt"
app = Flask(__name__)



class Rule:
    def __init__(self, conditions, conclusion):
        self.conditions = conditions
        self.conclusion = conclusion

    def __str__(self):
        conds = " И ".join(f"{o}={v}" for o, v in self.conditions)
        o, v = self.conclusion
        return f"ЕСЛИ {conds} ТО {o}={v}"


def parse_pair(text):
    """'объект=значение' -> ('объект', 'значение')"""
    parts = text.split("=")
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        raise ValueError(f"ожидается «объект=значение», получено: {text.strip()!r}")
    word = re.search(r"(?:^|\s)(И|ТО|ЕСЛИ)(?:\s|$)", text.strip())
    if word:
        raise ValueError(f"лишнее «{word.group(1)}» в {text.strip()!r}")
    return parts[0].strip(), parts[1].strip()


def parse_rule(line):
    """'ЕСЛИ a=1 И b=2 ТО c=3' -> Rule. Один парсер и для файла, и для API."""
    m = re.fullmatch(r"\s*ЕСЛИ\s+(.+?)\s+ТО\s+(.+?)\s*", line)
    if not m:
        raise ValueError("ожидается «ЕСЛИ о1=з1 [И о2=з2 ...] ТО о3=з3»")
    conditions = [parse_pair(p) for p in re.split(r"\s+И\s+", m.group(1))]
    return Rule(conditions, parse_pair(m.group(2)))


def load_rules():
    if not os.path.exists(RULES_FILE):
        return []
    result = []
    with open(RULES_FILE, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip() or line.strip().startswith("#"):
                continue
            try:
                result.append(parse_rule(line))
            except ValueError as e:
                print(f"{RULES_FILE}, строка {n} пропущена: {e}")
    return result


def save_rules():
    with open(RULES_FILE, "w", encoding="utf-8") as f:
        f.writelines(f"{r}\n" for r in rules)


rules = load_rules()


class Engine:
    def __init__(self):
        self.start({}, "")

    def start(self, facts, goal):
        """Задать стартовую ситуацию и цель."""
        self.start_facts = dict(facts)
        self.goal = goal
        self.restart()

    def restart(self):
        """Вернуть рабочую память к стартовой ситуации."""
        self.wm = dict(self.start_facts)   
        self.fired = set()                 
        self.trace = []                    
        self.status = "idle"               
        self.question = None               

    def run(self):
        """Прямой вывод: применяем правила, пока хоть одно срабатывает.
        Каждое правило срабатывает не больше одного раза, поэтому цикл
        гарантированно завершится — отдельная защита от зацикливания не нужна."""
        changed = True
        while changed:
            changed = False
            for i, r in enumerate(rules):
                if i in self.fired:
                    continue
                if all(self.wm.get(o) == v for o, v in r.conditions):
                    self.fired.add(i)
                    obj, val = r.conclusion
                    self.wm[obj] = val
                    self.trace.append(str(r))
                    changed = True

        if self.goal and self.goal in self.wm:
            self.status = "done"
        else:
            self.question = self.next_question()
            self.status = "ask" if self.question else "stopped"

    def next_question(self):
        """Неизвестный объект из правил, которые ещё могут сработать.
        В первую очередь спрашиваем то, что нельзя вывести другими правилами."""
        derivable = {r.conclusion[0] for r in rules}
        missing = []
        for i, r in enumerate(rules):
            if i in self.fired:
                continue
            if any(o in self.wm and self.wm[o] != v for o, v in r.conditions):
                continue  # одно из условий уже ложно — правило не сработает
            missing += [o for o, _ in r.conditions if o not in self.wm]

        for o in missing:
            if o != self.goal and o not in derivable:
                return o
        
        for o in missing:
            if o != self.goal:
                return o
        return None

    def answer(self, value):
        obj, self.question = self.question, None
        if not value:
            self.status = "stopped"   # сведений нет — завершаем работу
            return
        self.wm[obj] = value
        self.run()

    def options(self):
        """Значения, которые встречаются в правилах для объекта из вопроса."""
        if not self.question:
            return []
        return sorted({v for r in rules for o, v in r.conditions if o == self.question})

    def to_json(self):
        return {
            "status": self.status,
            "goal": self.goal,
            "answer": self.wm.get(self.goal) if self.status == "done" else None,
            "question": self.question,
            "options": self.options(),
            "wm": self.wm,
            "trace": self.trace,
        }


engine = Engine()


@app.errorhandler(ValueError)
def bad_request(e):
    return jsonify({"error": str(e)}), 400


def rule_from_request():
    j = request.get_json(silent=True) or {}
    return parse_rule(str(j.get("text") or ""))


def check_id(i):
    if i >= len(rules):
        abort(404)


def rules_changed():
    save_rules()
    engine.restart()   # после правки базы старые результаты вывода неактуальны
    return jsonify({"ok": True})


@app.get("/api/rules")
def get_rules():
    return jsonify([{"id": i, "text": str(r)} for i, r in enumerate(rules)])


@app.post("/api/rules")
def add_rule():
    rules.append(rule_from_request())
    return rules_changed()


@app.put("/api/rules/<int:i>")
def edit_rule(i):
    check_id(i)
    rules[i] = rule_from_request()
    return rules_changed()


@app.delete("/api/rules/<int:i>")
def delete_rule(i):
    check_id(i)
    del rules[i]
    return rules_changed()


@app.get("/api/state")
def get_state():
    return jsonify(engine.to_json())


@app.post("/api/start")
def start():
    """Тело: {"wm": {"объект": "значение", ...}, "goal": "объект"}"""
    j = request.get_json(silent=True) or {}
    wm = j.get("wm") or {}
    if not isinstance(wm, dict):
        raise ValueError("wm должен быть объектом {объект: значение}")
    facts = {str(k).strip(): str(v).strip() for k, v in wm.items() if str(k).strip()}
    engine.start(facts, str(j.get("goal") or "").strip())
    engine.run()
    return jsonify(engine.to_json())


@app.post("/api/answer")
def answer():
    """Тело: {"value": "..."}; пустое значение = «сведений нет»."""
    if engine.status != "ask":
        return jsonify({"error": "нет активного вопроса"}), 409
    j = request.get_json(silent=True) or {}
    engine.answer(str(j.get("value") or "").strip())
    return jsonify(engine.to_json())


@app.get("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    print(f"Загружено правил: {len(rules)}")
    app.run(host="127.0.0.1", port=8080, threaded=False)
