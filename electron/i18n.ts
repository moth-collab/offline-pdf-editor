/* Thai strings for the few native dialogs created by the main process. */
import { getSettings } from './services/store';

const TH: Record<string, string> = {
  'PDF documents': 'เอกสาร PDF',
  'PDF document': 'เอกสาร PDF',
  Images: 'รูปภาพ',
  'Digital ID (PKCS#12)': 'Digital ID (PKCS#12)',
  'All files': 'ไฟล์ทั้งหมด',
  'Word document': 'เอกสาร Word',
  'Excel workbook': 'สมุดงาน Excel',
  'PowerPoint presentation': 'งานนำเสนอ PowerPoint',
  'Text file': 'ไฟล์ข้อความ',
  'Open link': 'เปิดลิงก์',
  Cancel: 'ยกเลิก',
  OK: 'ตกลง',
  'Open this link in your web browser?': 'เปิดลิงก์นี้ในเว็บเบราว์เซอร์หรือไม่?',
  'The document itself is not sent anywhere.': 'ตัวเอกสารจะไม่ถูกส่งไปที่ใด',
};

export function mtr(s: string): string {
  return getSettings().language === 'th' ? (TH[s] ?? s) : s;
}
