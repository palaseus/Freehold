// Exact display formatting only. Currency precision comes from the REST API.
export function formatMinor(amount, precision) {
  if (!/^-?\d+$/.test(amount) || !Number.isInteger(precision) || precision < 0 || precision > 18) return 'Precision unavailable';
  const negative = amount.startsWith('-');
  const digits = (negative ? amount.slice(1) : amount).replace(/^0+(?=\d)/, '').padStart(precision + 1, '0');
  const whole = precision ? digits.slice(0, -precision) : digits;
  const fractional = precision ? '.' + digits.slice(-precision) : '';
  return (negative ? '−' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fractional;
}
