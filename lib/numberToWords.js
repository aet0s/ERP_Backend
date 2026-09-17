// Helper to convert numbers to Indian Rupee Words (e.g., 10500 -> "Rupees Ten Thousand Five Hundred Only")

const singleDigits = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function convertLessThanThousand(num) {
  let str = '';
  if (num >= 100) {
    str += singleDigits[Math.floor(num / 100)] + ' Hundred ';
    num %= 100;
  }
  if (num >= 10 && num <= 19) {
    str += teens[num - 10] + ' ';
  } else if (num >= 20) {
    str += tens[Math.floor(num / 10)] + ' ';
    if (num % 10 > 0) str += singleDigits[num % 10] + ' ';
  } else if (num > 0) {
    str += singleDigits[num] + ' ';
  }
  return str;
}

function numberToWordsINR(amount) {
  const num = Math.floor(Math.abs(Number(amount) || 0));
  if (num === 0) return 'Rupees Zero Only';

  let remaining = num;
  let str = '';

  // Crore (10,00,00,00)
  const crore = Math.floor(remaining / 10000000);
  if (crore > 0) {
    str += convertLessThanThousand(crore) + 'Crore ';
    remaining %= 10000000;
  }

  // Lakh (1,00,000)
  const lakh = Math.floor(remaining / 100000);
  if (lakh > 0) {
    str += convertLessThanThousand(lakh) + 'Lakh ';
    remaining %= 100000;
  }

  // Thousand (1,000)
  const thousand = Math.floor(remaining / 1000);
  if (thousand > 0) {
    str += convertLessThanThousand(thousand) + 'Thousand ';
    remaining %= 1000;
  }

  // Hundreds
  if (remaining > 0) {
    str += convertLessThanThousand(remaining);
  }

  const paise = Math.round((Math.abs(Number(amount) || 0) - num) * 100);
  let paiseStr = '';
  if (paise > 0) {
    paiseStr = ` and ${convertLessThanThousand(paise)}Paise`;
  }

  return `Rupees ${str.trim()}${paiseStr} Only`;
}

module.exports = { numberToWordsINR };
