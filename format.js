// ================================================================
//  RIVA — assets/format.js
//  Форматирование дат, сумм и чисел по требованиям ТЗ.
// ================================================================

const MONTHS_RU_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

/**
 * "19 апреля 2026 г."
 */
export function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  return `${date.getDate()} ${MONTHS_RU_GENITIVE[date.getMonth()]} ${date.getFullYear()} г.`;
}

/**
 * "(18:45) 19 апреля 2026 г."
 */
export function formatDateTime(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `(${hh}:${mm}) ${formatDate(date)}`;
}

/**
 * "1 234 567,89 ₽"
 * Разделитель тысяч — неразрывный пробел, десятичный — запятая.
 */
export function formatMoney(amount, { withCurrency = true } = {}) {
  const num = Number(amount);
  if (!isFinite(num)) return withCurrency ? '0,00\u00A0₽' : '0,00';
  const sign = num < 0 ? '−' : '';
  const abs = Math.abs(num);
  const [intPart, decPart] = abs.toFixed(2).split('.');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${sign}${intFmt},${decPart}${withCurrency ? '\u00A0₽' : ''}`;
}

/**
 * Количества: "12 500" или "12 500,5" (до 3 знаков после запятой без лишних нулей).
 */
export function formatNumber(value, { maxDecimals = 3 } = {}) {
  const num = Number(value);
  if (!isFinite(num)) return '0';
  const fixed = num.toFixed(maxDecimals).replace(/\.?0+$/, '');
  const [intPart, decPart] = fixed.split('.');
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return decPart ? `${intFmt},${decPart}` : intFmt;
}

/**
 * Количество + единица измерения: "12 500 шт"
 */
export function formatQuantity(value, unit) {
  const n = formatNumber(value);
  return unit ? `${n}\u00A0${unit}` : n;
}
