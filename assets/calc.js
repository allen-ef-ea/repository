/* ===============================================================
 * 底薪核算引擎
 *
 * 底薪 = 岗位薪资（职级 → 部门薪级表） − 考勤扣款
 * 计薪天数 = 应出勤 + 法定节假日
 * 病假工资 = 当地最低工资 × 比例 ÷ 计薪天数 × 天数
 * 实习生  = 时薪 × 工时
 *
 * 规则分层：
 *   全局  —— 城市最低工资表（跟地域有关，与部门无关）
 *   按部门 —— 薪级表 + 各项扣减参数
 *
 * 纯函数，不依赖 DOM。
 * =============================================================== */
(function (global) {
  'use strict';

  const HOLIDAYS = {
    '2026-01-01': '元旦',
    '2026-02-17': '春节', '2026-02-18': '春节', '2026-02-19': '春节',
    '2026-04-05': '清明',
    '2026-05-01': '劳动节',
    '2026-06-19': '端午',
    '2026-09-25': '中秋',
    '2026-10-01': '国庆', '2026-10-02': '国庆', '2026-10-03': '国庆',
    '2027-01-01': '元旦',
  };

  const FALLBACK_DEPT = '未分部门';

  function deptRule(grades, extra) {
    return Object.assign({
      grades: grades,
      personalRatio: 1,
      sickRatio: 0.8,
      absenceMultiple: 1,
      missingAsAbsence: true,
      lateMode: 'perTime',
      lateFee: 50,
      prorate: 'forward',
    }, extra || {});
  }

  const DEFAULT_RULE = {
    cities: { 上海: 2660, 苏州: 2540 },
    depts: {
      '算法部': deptRule({ P1: 12000, P2: 18000, P3: 25000, P4: 35000 }),
      '销售部': deptRule({ S1: 5000, S2: 6000, S3: 7000 }, { lateFee: 30 }),
      [FALLBACK_DEPT]: deptRule({ P1: 8000, P2: 12000, P3: 15000 }),
    },
  };

  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

  function parsePeriod(p) {
    const [y, m] = String(p).split('-').map(Number);
    return { y, m, days: new Date(y, m, 0).getDate() };
  }

  const isHoliday = (s) => !!HOLIDAYS[s];
  function isWeekend(s) {
    const p = s.split('-').map(Number);
    const w = new Date(p[0], p[1] - 1, p[2]).getDay();
    return w === 0 || w === 6;
  }
  const isWorkday = (s) => !isWeekend(s) && !isHoliday(s);

  function monthDates(period) {
    const { y, m, days } = parsePeriod(period);
    const out = [];
    for (let i = 1; i <= days; i++) out.push(y + '-' + pad(m) + '-' + pad(i));
    return out;
  }

  const workdaysOf = (period) => monthDates(period).filter(isWorkday).length;
  const holidayCountOf = (period) => monthDates(period).filter(isHoliday).length;

  /** 计薪天数 = 应出勤 + 法定节假日 */
  const payDaysOf = (period) => workdaysOf(period) + holidayCountOf(period);

  const workdaysBetween = (s, e, period) =>
    monthDates(period).filter((d) => d >= s && d <= e && isWorkday(d)).length;

  function yearsBetween(startStr, endStr) {
    if (!startStr) return null;
    const a = startStr.split('-').map(Number);
    const b = endStr.split('-').map(Number);
    let months = (b[0] - a[0]) * 12 + (b[1] - a[1]);
    if (b[2] < a[2]) months -= 1;
    return Math.max(0, months) / 12;
  }

  /** 取某员工适用的部门规则；找不到就落到兜底部门 */
  function ruleOf(dept, rule) {
    const d = rule.depts || {};
    return d[dept] || d[FALLBACK_DEPT] || d[Object.keys(d)[0]] || deptRule({});
  }

  /* -------------------------------------------------------------
   * 实习生：时薪 × 工时
   * ----------------------------------------------------------- */
  function computeIntern(emp, recs) {
    const rate = emp.hourRate || 0;
    let hours = 0;
    recs.forEach((r) => { if (r.hours > 0) hours += r.hours; });

    const pay = round2(rate * hours);
    const lines = [{
      item: '实习工资', amount: pay,
      formula: `${fmt(rate)} 元/小时 × ${round2(hours)} 小时${hours === 0 ? '（未填工时）' : ''}`,
      kind: 'base',
    }];

    const flags = [];
    if (!rate) flags.push({ level: 'bad', text: '缺时薪' });
    if (!hours) flags.push({ level: 'warn', text: '无工时' });

    return {
      id: emp.id, name: emp.name || emp.id, dept: emp.dept || FALLBACK_DEPT,
      grade: '实习', kind: 'intern', city: emp.city || '',
      hourRate: rate, hours: round2(hours),
      salary: pay, dayRate: rate, payDays: 0,
      base: pay, net: pay, deduct: 0, lines,
      summary: hours ? [`工时 ${round2(hours)}h`] : [],
      flag: flags[0] || null,
    };
  }

  /* -------------------------------------------------------------
   * 正式员工
   * ----------------------------------------------------------- */
  function computeStaff(emp, recs, cfg, deptRuleObj) {
    const period = cfg.period;
    const first = period + '-01';
    const last = period + '-' + pad(parsePeriod(period).days);

    const salary = Number(deptRuleObj.grades[emp.grade]) || 0;
    const payDays = cfg.payDays;
    const dayRate = salary / payDays;

    const from = emp.hireDate && emp.hireDate > first ? emp.hireDate : first;
    const to = emp.resignDate && emp.resignDate < last ? emp.resignDate : last;
    if (from > to) return null;

    const inDays = workdaysBetween(from, to, period);
    const wholeMonth = from === first && to === last;

    let base, baseNote;
    if (wholeMonth) {
      base = round2(salary);
      baseNote = `职级 ${emp.grade} 岗位薪资 ${fmt(salary)}，整月在职`;
    } else if (deptRuleObj.prorate === 'backward') {
      const outside = cfg.workdays - inDays;
      base = round2(salary - dayRate * outside);
      baseNote = `${fmt(salary)} − ${fmt(salary)} ÷ ${payDays} × ${outside} 天（未在职）`;
    } else {
      base = round2(dayRate * inDays);
      baseNote = `${fmt(salary)} ÷ ${payDays} × ${inDays} 天（在职计薪日）`;
    }
    base = Math.max(0, base);

    const lines = [{ item: '岗位薪资', amount: base, formula: baseNote, kind: 'base' }];

    const buckets = new Map();
    const put = (item, qty, unit, per, note, date) => {
      const key = item + '|' + round2(per, 4);
      if (!buckets.has(key)) buckets.set(key, { item, qty: 0, unit, per, note, dates: [] });
      const b = buckets.get(key);
      b.qty += qty;
      if (date) b.dates.push(date.slice(5));
    };

    const minWage = Number(cfg.cities[emp.city]) || 0;
    const sickPerDay = minWage > 0 ? (minWage * deptRuleObj.sickRatio) / payDays : 0;

    recs.forEach((r) => {
      if (r.date < from || r.date > to) return;
      const d = r.days == null ? 1 : r.days;

      if (r.type === '事假') {
        put('事假扣款', d, '天', dayRate * deptRuleObj.personalRatio,
          `本人日薪 × ${Math.round(deptRuleObj.personalRatio * 100)}%`, r.date);

      } else if (r.type === '病假') {
        if (sickPerDay <= 0) {
          put('病假扣款', d, '天', dayRate, '未配置该城市最低工资，按全扣处理', r.date);
        } else {
          const per = dayRate - sickPerDay;
          if (per >= 0) {
            put('病假扣款', d, '天', per,
              `本人日薪 ${fmt(dayRate)} − 病假日工资 ${fmt(sickPerDay)}（${emp.city}最低工资 ${fmt(minWage)} × ${Math.round(deptRuleObj.sickRatio * 100)}% ÷ ${payDays}）`, r.date);
          } else {
            put('病假补差', d, '天', -per, `病假日工资 ${fmt(sickPerDay)} 高于本人日薪，补足差额`, r.date);
          }
        }

      } else if (r.type === '旷工') {
        put('旷工扣款', d, '天', dayRate * deptRuleObj.absenceMultiple,
          `本人日薪 × ${deptRuleObj.absenceMultiple * 100}%`, r.date);

      } else if (r.type === '缺卡') {
        if (deptRuleObj.missingAsAbsence) put('缺卡视为旷工', d, '天', dayRate, '缺卡未补，按旷工计', r.date);

      } else if (r.type === '迟到' || r.type === '早退') {
        if (deptRuleObj.lateMode === 'none') return;
        const label = r.type === '迟到' ? '迟到扣款' : '早退扣款';
        if (deptRuleObj.lateMode === 'perTime') {
          put(label, 1, '次', deptRuleObj.lateFee, `每次 ${fmt(deptRuleObj.lateFee)} 元`, r.date);
        } else {
          const min = r.late || 0;
          if (min <= 0) return;
          put(label, min, '分钟', dayRate / 480, '本人日薪 ÷ 480 × 分钟', r.date);
        }
      }
    });

    buckets.forEach((b) => {
      if (b.per === 0) return;
      const span = b.dates.length > 4
        ? `${b.dates[0]} 至 ${b.dates[b.dates.length - 1]}`
        : b.dates.join('、');
      const isTop = b.item.includes('补差');
      lines.push({
        item: b.item,
        amount: (isTop ? 1 : -1) * round2(b.per * b.qty),
        formula: `${b.note} × ${round2(b.qty)} ${b.unit}（${span}）`,
        kind: isTop ? 'add' : 'deduct',
      });
    });

    const net = round2(lines.reduce((s, l) => s + l.amount, 0));
    const deduct = round2(net - base);

    const summary = [];
    buckets.forEach((b) => { if (b.qty > 0) summary.push(b.item.replace('扣款', '').replace('视为旷工', '') + ' ' + round2(b.qty)); });

    const flags = [];
    if (!salary) flags.push({ level: 'bad', text: '职级未配薪' });
    if (net < 0) flags.push({ level: 'bad', text: '结果为负' });
    if (!wholeMonth) flags.push({ level: 'warn', text: from > first ? '中途入职' : '中途离职' });
    if (!emp.city && recs.some((r) => r.type === '病假')) flags.push({ level: 'warn', text: '缺城市' });

    return {
      id: emp.id, name: emp.name || emp.id, dept: emp.dept || FALLBACK_DEPT,
      grade: emp.grade || '—', kind: 'staff', city: emp.city || '',
      salary, dayRate: round2(dayRate), payDays,
      base, net, deduct, lines, summary,
      flag: flags[0] || null,
    };
  }

  /* -------------------------------------------------------------
   * 全员核算
   * ----------------------------------------------------------- */
  function compute(employees, records, cfgIn) {
    const workdays = workdaysOf(cfgIn.period);
    const payDays = payDaysOf(cfgIn.period);
    const cfg = Object.assign({}, cfgIn, {
      workdays, payDays,
      cities: (cfgIn.rule && cfgIn.rule.cities) || {},
    });

    const empMap = new Map();
    employees.forEach((e) => empMap.set(e.id, Object.assign({}, e)));
    records.forEach((r) => {
      if (!empMap.has(r.id)) empMap.set(r.id, { id: r.id, name: r.id, grade: '', dept: '', missing: true });
    });

    const byEmp = new Map();
    empMap.forEach((_, id) => byEmp.set(id, []));
    records.forEach((r) => { if (byEmp.has(r.id)) byEmp.get(r.id).push(r); });

    const rows = [];
    empMap.forEach((emp) => {
      const recs = byEmp.get(emp.id) || [];
      if (emp.kind === 'intern') {
        rows.push(computeIntern(emp, recs));
      } else {
        const dr = ruleOf(emp.dept, cfgIn.rule);
        const res = computeStaff(emp, recs, cfg, dr);
        if (res) {
          // 部门没有对应规则时不能静默套用兜底，要让人看见
          if (emp.dept && !(cfgIn.rule.depts || {})[emp.dept] && (!res.flag || res.flag.level !== 'bad')) {
            res.flag = { level: 'warn', text: '部门未配规则' };
          }
          rows.push(res);
        }
      }
    });
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const sum = (arr, k) => round2(arr.reduce((s, r) => s + r[k], 0));

    /* 按部门分组 */
    const groups = new Map();
    rows.forEach((r) => {
      const k = r.dept || FALLBACK_DEPT;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });

    const depts = Array.from(groups.keys()).map((k) => {
      const arr = groups.get(k);
      return {
        dept: k,
        rows: arr,
        totals: {
          people: arr.length,
          base: sum(arr, 'base'),
          net: sum(arr, 'net'),
          deduct: round2(sum(arr, 'net') - sum(arr, 'base')),
          abnormal: arr.filter((r) => r.flag && r.flag.level === 'bad').length,
        },
      };
    });
    // 顺序：按规则里部门的顺序，兜底放最后
    const order = Object.keys((cfgIn.rule && cfgIn.rule.depts) || {});
    depts.sort((a, b) => {
      const ia = order.indexOf(a.dept), ib = order.indexOf(b.dept);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

    return {
      rows, depts, cfg,
      totals: {
        people: rows.length,
        base: sum(rows, 'base'),
        net: sum(rows, 'net'),
        deduct: round2(sum(rows, 'net') - sum(rows, 'base')),
        abnormal: rows.filter((r) => r.flag && r.flag.level === 'bad').length,
      },
    };
  }

  global.BP = {
    compute, DEFAULT_RULE, FALLBACK_DEPT, deptRule, ruleOf,
    workdaysOf, payDaysOf, holidayCountOf, workdaysBetween,
    isWorkday, isWeekend, isHoliday, monthDates, parsePeriod,
    yearsBetween, HOLIDAYS, round2, fmt,
  };
})(typeof window !== 'undefined' ? window : globalThis);
