import { buildSeed } from '../src/domain/seed';
import { computeEcon, totalsOf, groupEcon, businessCosts } from '../src/domain/economics';
import { balancesBetween, natBal } from '../src/domain/accounting';
const db = buildSeed(new Date());
console.log('seed errors', db._seedErrors?.length, db._seedErrors?.slice(0,3));
const { orders } = computeEcon(db, {});
const t = totalsOf(orders);
console.log(t);
const g = groupEcon(orders, (e) => e.channel);
for (const [k, v] of Object.entries(g)) console.log(k.padEnd(8), 'orders', v.orders, 'net', Math.round(v.net), 'GP%', (v.grossProfit / v.net * 100).toFixed(1), 'contrib', Math.round(v.contribution));
console.log(businessCosts(db));
const b = balancesBetween(db.journals);
for (const a of db.accounts) { const x = natBal(a, b[a.code]); if (x) console.log(a.code, a.name.padEnd(46), x.toLocaleString()); }
const today = new Date().toISOString().slice(0,10);
console.log('orders by status', db.orders.reduce((m: any, o) => (m[o.status] = (m[o.status]||0)+1, m), {}));
console.log('today orders', db.orders.filter(o=>o.createdAt.slice(0,10)===today).length);
