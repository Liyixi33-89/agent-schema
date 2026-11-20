/**
 * 维护公告 feature 显式导出。
 */
export { default as NoticesPage } from './NoticesPage';
export { fetchNotices, publishNotice, deactivateNotice, parseNotices, type NoticeItem } from './api';