import * as express from 'express';
import * as Knex from 'knex';
import * as moment from 'moment';
import * as path from 'path';
import * as os from 'os';
import * as xlsx from 'node-xlsx';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as json2xls from 'json2xls';
import * as multer from 'multer';
import * as rimraf from 'rimraf';
import * as _ from 'lodash';
import PlanningModel from '../models/planning';
import ReportModel from '../models/report';

const router = express.Router();

const planningModel = new PlanningModel();
const reportModel = new ReportModel();

/**
 * แปลงวันที่จากฐานข้อมูลเป็นข้อความ โดยคืน null ถ้าค่าว่างหรือไม่ใช่วันที่
 *
 * moment(null).format() คืนข้อความว่า 'Invalid date' ซึ่งพอเอาไป insert
 * MySQL จะปฏิเสธด้วย ER_TRUNCATED_WRONG_VALUE แล้วงานทั้งชุดพัง
 * คอลัมน์อย่าง inventory_date เป็น NULL ได้ตามโครงสร้างตาราง จึงต้องกันไว้
 */
function toDbDate(value: any): string {
  if (!value) {
    return null;
  }
  const m = moment(value);
  return m.isValid() ? m.format('YYYY-MM-DD HH:mm:ss') : null;
}

/**
 * เก็บกวาดร่างแผนที่ถูกทิ้งค้างไว้ เรียกตอนที่ผู้ใช้เริ่มงานชุดใหม่เท่านั้น
 *
 * ไม่แขวนที่ GET /tmp เพราะถูกเรียกทุกครั้งที่เปลี่ยนหน้า ค้นหา หรือกรอง
 * ถี่เกินความจำเป็นมาก
 *
 * ห้ามทำให้งานหลักล้ม การเก็บกวาดพังไม่ใช่เรื่องที่ผู้ใช้ต้องรับรู้
 */
const TMP_EXPIRE_DAYS = 7;
const TMP_CLEAN_LIMIT = 1000;

async function cleanExpiredTmp(db: Knex, currentUuid: any) {
  try {
    await planningModel.clearExpiredPlanningTmp(db, currentUuid, TMP_EXPIRE_DAYS, TMP_CLEAN_LIMIT);
  } catch (error) {
    console.log('clean expired planning tmp failed:', error.message);
  }
}

router.get('/', async (req, res, next) => {
  let db = req.db;
  let planningYear = req.query.year;
  let planningStatus = req.query.status;
  let planningName = req.query.name;

  try {
    let _planningName = planningName == 'undefined' || planningName == 'null' ? '' : planningName;
    let rs: any = await planningModel.getPlanningHeader(db, planningYear, planningStatus, _planningName);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/info/:headerId', async (req, res, next) => {
  let db = req.db;
  let planningHeaderId = req.params.headerId;

  try {
    let rs: any = await planningModel.getPlanningHeaderInfo(db, planningHeaderId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/', async (req, res, next) => {
  let _header = req.body.header;
  let _uuid = req.body.uuid;
  let db = req.db;
  if (_uuid && _header) {
    try {
      // สร้างหัวแผนแล้วเขียนรายละเอียด ถ้าขั้นไหนพังต้องย้อนกลับทั้งหมด
      // ไม่งั้นจะเหลือหัวแผนลอยที่ไม่มีรายการสักรายการ
      await db.transaction(async (trx) => {
        /**
         * ไม่มีรายการใน tmp = บันทึกไม่ได้
         *
         * การบันทึกอ่านรายการจาก tmp อย่างเดียว ถ้า tmp ว่างจะได้แผนเปล่า
         * โดยไม่มี error เลย (INSERT...SELECT ที่ไม่มีแถวไม่ถือว่าผิดพลาด)
         *
         * tmp ว่างได้จากหลายทาง — เปิดค้างไว้จนถูกล้างอัตโนมัติ
         * เปิดสองแท็บแล้วบันทึกแท็บแรกไปก่อน หรือกดบันทึกรัวจนสองคำขอวิ่งพร้อมกัน
         *
         * ต้องเช็คในทรานแซกชันเดียวกับการเขียน ไม่งั้นสองคำขอที่วิ่งพร้อมกันจะผ่านทั้งคู่
         */
        const _cnt: any = await planningModel.countPlanningTmpForSave(trx, _uuid);
        if (!+_cnt[0].total) {
          throw new Error('ไม่มีรายการที่จะบันทึก ข้อมูลอาจหมดอายุแล้ว กรุณาเปิดแผนขึ้นมาใหม่');
        }

        /**
         * ทั้งโมดูลถือว่า ปีงบประมาณ + ชื่อแผน = แผนหนึ่งฉบับ
         * ตอนบันทึกแผนที่ยืนยันแล้ว updatePlanningInactive จะปิดแผนทุกฉบับ
         * ที่ปีและชื่อตรงกันให้เป็นประวัติของฉบับใหม่
         * ถ้าปล่อยให้สร้างชื่อซ้ำได้ อีกฉบับจะถูกกลืนหายไปจากหน้ารายการ
         *
         * เช็คในทรานแซกชันเดียวกับการเขียน เพื่อไม่ให้สองคนกดพร้อมกันแล้วผ่านทั้งคู่
         */
        const _dup: any = await planningModel.findActivePlanningByName(
          trx, _header.planningYear, _header.planningName);
        if (_dup.length) {
          throw new Error('มีแผนชื่อนี้ในปีงบประมาณนี้อยู่แล้ว กรุณาตั้งชื่อแผนใหม่');
        }

        await insertPlanning(trx, _header, _uuid, req.decoded.people_user_id);
        await planningModel.clearPlanningTmp(trx, _uuid);
      });
      res.send({ ok: true });
    } catch (error) {
      res.send({ ok: false, error: error.message });
    } finally {
      db.destroy();
    }
  } else {
    res.send({ ok: false, error: 'ไม่พบข้อมูลที่ต้องการบันทึก' });
  }
});

router.put('/', async (req, res, next) => {
  let _header = req.body.header;
  let _uuid = req.body.uuid;
  let db = req.db;
  if (_uuid && _header) {
    try {
      let result: any = await planningModel.checkPlanningConfirm(db, _header.planningYear, _header.planningName);

      // หน้าจอปิดไม่ให้แก้ปีและชื่อแผนอยู่แล้ว แต่ถ้ามีการเรียก API ตรงด้วยชื่อที่ไม่ตรงกับของเดิม
      // result จะว่าง แล้ว result[0].confirmed จะพังด้วยข้อความที่ผู้ใช้อ่านไม่รู้เรื่อง
      if (!result.length) {
        res.send({ ok: false, error: 'ไม่พบแผนที่ต้องการบันทึก (ปีงบประมาณหรือชื่อแผนไม่ตรงกับข้อมูลเดิม)' });
        return;
      }

      /**
       * ต้องอยู่ใน transaction เดียวกันทั้งหมด
       *
       * เส้นทาง updatePlanning ลบรายละเอียดของแผนที่บันทึกไว้แล้วก่อนเขียนใหม่
       * ถ้าเขียนใหม่พังกลางทาง แผนนั้นจะเหลือแต่หัว ไม่มีรายการเลยสักรายการ
       * และกู้ไม่ได้เพราะข้อมูลเดิมถูกลบไปแล้ว
       */
      // แก้แผนที่ยืนยันแล้วจะได้ฉบับใหม่ที่ต้องยืนยันอีกครั้ง ต้องบอกหน้าจอให้แจ้งผู้ใช้
      // ไม่งั้นผู้ใช้กดยืนยันแล้วเห็นสถานะเป็น "รอยืนยัน" จะนึกว่าปุ่มไม่ทำงาน
      const isNewRevision = result[0].confirmed === 'Y';

      await db.transaction(async (trx) => {
        /**
         * ไม่มีรายการใน tmp = บันทึกไม่ได้ (เหตุผลเดียวกับใน POST /)
         *
         * เส้นทางนี้อันตรายกว่า เพราะ updatePlanning ลบรายละเอียดของแผนเดิมทิ้งก่อน
         * แล้วเขียนใหม่จาก tmp ถ้า tmp ว่าง แผนที่เคยมีข้อมูลจะกลายเป็นแผนเปล่า
         * และไม่มี error ขึ้นเลย พิสูจน์กับฐานจริงแล้ว
         */
        const _cnt: any = await planningModel.countPlanningTmpForSave(trx, _uuid);
        if (!+_cnt[0].total) {
          throw new Error('ไม่มีรายการที่จะบันทึก ข้อมูลอาจหมดอายุแล้ว กรุณาเปิดแผนขึ้นมาใหม่');
        }

        if (isNewRevision) {
          let planningHeaderId = await insertPlanning(trx, _header, _uuid, req.decoded.people_user_id);
          await planningModel.updatePlanningInactive(trx, _header.planningYear, _header.planningName, planningHeaderId);
        } else {
          await updatePlanning(trx, _header, _uuid, req.decoded.people_user_id);
        }
        await planningModel.clearPlanningTmp(trx, _uuid);
      });
      res.send({ ok: true, newRevision: isNewRevision });
    } catch (error) {
      res.send({ ok: false, error: error.message });
    } finally {
      db.destroy();
    }
  } else {
    res.send({ ok: false, error: 'ไม่พบข้อมูลที่ต้องการบันทึก' });
  }
});

router.get('/detail/:headerId', async (req, res, next) => {
  let db = req.db;
  let planningHeaderId = req.params.headerId;
  let _uuid = req.query.uuid;

  try {
    // เปิดหน้าแก้ไข = เริ่มงานชุดใหม่ ถือโอกาสเก็บกวาดของเก่าที่ถูกทิ้งค้างไว้
    await cleanExpiredTmp(db, _uuid);

    let rs: any = await planningModel.getPlanningDetail(db, planningHeaderId);
    let data = [];
    for (const r of rs) {
      let obj: any = {};
      obj.uuid = _uuid;
      obj.generic_id = r.generic_id;
      obj.generic_name = r.generic_name;
      obj.unit_generic_id = r.unit_generic_id;
      obj.unit_desc = `${r.from_unit_name} (${r.conversion_qty} ${r.to_unit_name})`;
      obj.unit_cost = r.unit_cost;
      obj.conversion_qty = r.conversion_qty;
      obj.primary_unit_id = r.primary_unit_id;
      obj.rate_1_year = Math.round(r.rate_1_year / r.conversion_qty);
      obj.rate_2_year = Math.round(r.rate_2_year / r.conversion_qty);
      obj.rate_3_year = Math.round(r.rate_3_year / r.conversion_qty);
      obj.estimate_qty = Math.round(r.estimate_qty / r.conversion_qty);
      obj.stock_qty = Math.round(r.stock_qty / r.conversion_qty);
      obj.inventory_date = toDbDate(r.inventory_date);
      obj.estimate_buy = Math.round(r.estimate_buy / r.conversion_qty);
      obj.q1 = Math.round(r.q1 / r.conversion_qty);
      obj.q2 = Math.round(r.q2 / r.conversion_qty);
      obj.q3 = Math.round(r.q3 / r.conversion_qty);
      obj.q4 = Math.round(r.q4 / r.conversion_qty);
      obj.qty = obj.q1 + obj.q2 + obj.q3 + obj.q4;
      obj.amount = obj.qty * obj.unit_cost;
      // obj.bid_type_id = r.bid_type_id;
      // obj.bid_type_name = r.bid_type_name;
      obj.freeze = r.freeze;
      obj.create_date = toDbDate(r.create_date);
      obj.update_date = toDbDate(r.update_date);
      obj.create_by = r.create_by;
      obj.update_by = r.update_by;
      obj.generic_type_name = r.generic_type_name === 'ยา' ? r.account_name : r.generic_type_name;
      obj.generic_type_id = r.generic_type_id;
      data.push(obj);
    }
    await planningModel.insertPlanningTmp(db, data);
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/year', async (req, res, next) => {
  let db = req.db;
  try {
    let rs: any = await planningModel.getPlanningYear(db);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/forecast', async (req, res, next) => {
  let db = req.db;
  let forecastYear = req.body.year;
  let warehouseId = req.decoded.warehouseId;

  try {
    await planningModel.callForecast(db, forecastYear, warehouseId);
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/forecast/:genericId/:year', async (req, res, next) => {
  let db = req.db;
  let genericId = req.params.genericId;
  let forecastYear = req.params.year;
  let tmpId = req.query.tmpId;
  let warehouseId = req.decoded.warehouseId;

  try {
    let _tmpId = tmpId === 'undefined' ? null : +tmpId;
    let rs: any = await planningModel.getForecast(db, genericId, forecastYear, _tmpId, warehouseId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/process', async (req, res, next) => {
  let db = req.db;
  let planningYear = req.body.year;
  let _uuid = req.body.uuid;
  let genericTypeIds = req.body.genericTypeIds;
  let genericGroups = req.decoded.generic_type_id;
  let warehouseId = req.decoded.warehouseId;

  try {
    // ประมวลผลพยากรณ์ = เริ่มงานชุดใหม่ ถือโอกาสเก็บกวาดของเก่าที่ถูกทิ้งค้างไว้
    await cleanExpiredTmp(db, _uuid);

    if (genericGroups) {

      let _ggs = [];
      let ggs = genericGroups.split(',');
      ggs.forEach(v => {
        _ggs.push(String(v).trim());
      });

      /**
       * ตัดเฉพาะหมวดที่ผู้ใช้มีสิทธิ์จริง
       *
       * เดิมสร้าง _ggs จาก req.decoded.generic_type_id ไว้แล้วไม่ได้เอาไปใช้เลย
       * แล้วส่ง genericTypeIds จาก req.body เข้า query ตรงๆ
       *
       * หน้าจอดึงรายการหมวดจาก /standard/generic-types ซึ่งกรองตามสิทธิ์ให้อยู่แล้ว
       * ผู้ใช้จึงเห็นเฉพาะของตัวเอง แต่ฝั่ง API ไม่ได้บังคับ ใครยิงเองก็ขอหมวดอื่นได้
       */
      const allowedTypeIds = (genericTypeIds || [])
        .filter(id => _ggs.indexOf(String(id).trim()) > -1);

      if (!allowedTypeIds.length) {
        res.send({ ok: false, error: 'ไม่มีสิทธิ์ในประเภทหมวดสินค้าที่เลือก' });
        return;
      }

      if (allowedTypeIds.length) {
        // await planningModel.callForecast(db, planningYear);
        let rs: any = await planningModel.getForecastList(db, planningYear, allowedTypeIds, warehouseId);
        let data = [];
        for (const r of rs) {
          let obj: any = {};
          obj.uuid = _uuid;
          obj.generic_id = r.generic_id;
          obj.generic_name = r.generic_name;
          obj.unit_generic_id = r.planning_unit_generic_id;
          obj.unit_desc = `${r.from_unit_name} (${r.conversion_qty} ${r.to_unit_name})`;
          obj.unit_cost = r.cost;
          obj.conversion_qty = r.conversion_qty;
          obj.primary_unit_id = r.to_unit_id;
          obj.rate_1_year = Math.round(r.sumy1 / r.conversion_qty);
          obj.rate_2_year = Math.round(r.sumy2 / r.conversion_qty);
          obj.rate_3_year = Math.round(r.sumy3 / r.conversion_qty);
          obj.estimate_qty = Math.round(r.sumy4 / r.conversion_qty);
          obj.stock_qty = Math.round(r.stock_qty / r.conversion_qty);
          obj.inventory_date = toDbDate(r.process_date);
          obj.estimate_buy = Math.round(r.buy_qty / r.conversion_qty);
          obj.q1 = Math.round(r.y4q1 / r.conversion_qty);
          obj.q2 = Math.round(r.y4q2 / r.conversion_qty);
          obj.q3 = Math.round(r.y4q3 / r.conversion_qty);
          obj.q4 = Math.round(r.y4q4 / r.conversion_qty);
          obj.qty = obj.q1 + obj.q2 + obj.q3 + obj.q4;
          obj.amount = obj.qty * obj.unit_cost;
          // obj.bid_type_id = r.planning_method;
          // obj.bid_type_name = r.bid_type_name;
          obj.freeze = r.planning_freeze ? 'Y' : 'N';
          obj.create_date = moment().format('YYYY-MM-DD HH:mm:ss');
          obj.create_by = req.decoded.people_user_id;
          obj.generic_type_id = r.generic_type_id;
          data.push(obj);
        }
        /**
         * ไม่มีผลลัพธ์ = ห้ามแตะร่างแผนเดิม
         *
         * รายการหมวดสินค้าที่ให้ติ๊กมาจากสิทธิ์ของผู้ใช้อย่างเดียว ไม่ได้ดูว่าคลังนั้น
         * มีของในหมวดนั้นจริงไหม (ตรวจคลัง 10 แล้วพบ 3 หมวดที่เลือกได้แต่ไม่มีข้อมูลเลย)
         * และต่อให้หมวดมีของ ปีที่เลือกก็อาจยังไม่มีข้อมูลพยากรณ์
         *
         * เดิมกรณีนี้จะล้างร่างแผนทิ้งแล้วเขียนรายการว่างลงไป โดยไม่ throw error เลย
         * ผู้ใช้ที่ทำแผนค้างไว้แล้วเผลอกดคำนวณจะเสียงานทั้งหมดและระบบขึ้นว่าสำเร็จ
         */
        if (!data.length) {
          res.send({
            ok: false,
            error: 'ไม่พบข้อมูลพยากรณ์ตามหมวดสินค้าและปีที่เลือก รายการเดิมในแผนไม่ถูกแก้ไข'
          });
          return;
        }

        /**
         * ล้างของเดิมกับเขียนของใหม่ต้องอยู่ในทรานแซกชันเดียวกัน
         * ถ้า insert พังกลางทาง ร่างแผนที่ทำค้างไว้จะหายถาวรเพราะลบไปก่อนแล้ว
         */
        await db.transaction(async (trx) => {
          await planningModel.clearPlanningTmp(trx, _uuid);
          await planningModel.insertPlanningTmp(trx, data);
        });
        res.send({ ok: true });
      } else {
        res.send({ ok: false, error: 'กรุณาเลือกประเภทหมวดสินค้า' });
      }
    } else {
      res.send({ ok: false, error: 'ไม่พบการกำหนดเงื่อนไขประเภทสินค้า' });
    }
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/tmp', async (req, res, next) => {
  let db = req.db;
  let _uuid = req.query.uuid;
  let query = req.query.query;
  let genericType = req.query.genericType;
  let limit = +req.query.limit || 5;
  let offset = +req.query.offset || 0;

  try {
    let _query = query === 'undefined' || query === null ? '' : query;
    let _genericType = genericType === 'undefined' || genericType === null ? '' : genericType;
    let rs = await planningModel.getPlanningTmp(db, _uuid, _query, _genericType, limit, offset);
    let header = await planningModel.countPlanningTmp(db, _uuid, _query, _genericType);

    /**
     * ต้องคืนยอดของ "ทั้งร่างแผน" แยกจากยอดที่ผ่านตัวกรอง
     *
     * total/amount ผ่านตัวกรองเดียวกับตาราง จึงใช้กับการแบ่งหน้าได้ถูก
     * แต่หน้าจอเอาสองค่านี้ไปบันทึกเป็นยอดรวมและจำนวนรายการของทั้งแผนด้วย
     * ผลคือถ้ากรองหมวดหรือค้นหาอยู่แล้วกดบันทึก หัวแผนจะเก็บยอดของเฉพาะที่กรองไว้
     * ทั้งที่รายการถูกบันทึกครบทุกแถว (insertPlanningDetailFromTmp ไม่สนตัวกรอง)
     *
     * ยิงซ้ำเฉพาะตอนที่มีตัวกรองจริง ๆ ถ้าไม่มีก็ใช้ผลเดิม ไม่เพิ่มภาระ query
     */
    let headerAll = header;
    if (_query || _genericType) {
      headerAll = await planningModel.countPlanningTmp(db, _uuid, null, null);
    }

    res.send({
      ok: true, rows: rs,
      total: header[0].total, amount: header[0].amount,
      totalAll: headerAll[0].total, amountAll: headerAll[0].amount || 0
    });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/tmp', async (req, res, next) => {
  let db = req.db;
  let _uuid = req.body.uuid;
  let data = req.body.data;

  try {
    /**
     * กันเพิ่มยาตัวเดิมซ้ำในแผนเดียวกัน
     *
     * ดีไซน์กำหนดให้ยา 1 ตัวมีหน่วยวางแผนเดียว (mm_generics.planning_unit_generic_id)
     * แผนจึงควรมีบรรทัดเดียวต่อยา 1 ตัว
     *
     * ตารางมี UNIQUE KEY (uuid, planning_hdr_id, generic_id) อยู่แล้วแต่ใช้ไม่ได้จริง
     * เพราะ planning_hdr_id เป็น NULL เสมอในตารางชั่วคราว และ MySQL ถือว่า
     * NULL ไม่เท่ากับ NULL ของซ้ำจึงหลุดเข้ามาได้ ต้องกันที่โค้ดแทน
     */
    if (data.generic_id) {
      const exists: any = await planningModel.findPlanningTmpByGeneric(db, _uuid, data.generic_id);
      if (exists.length) {
        res.send({ ok: false, error: 'มีรายการยานี้ในแผนอยู่แล้ว กรุณาแก้ไขรายการเดิมแทนการเพิ่มใหม่' });
        return;
      }
    }

    data.uuid = _uuid;
    data.create_date = moment().format('YYYY-MM-DD HH:mm:ss');
    data.create_by = req.decoded.people_user_id;
    // เหตุผลเดียวกับใน PUT /tmp — ยาที่ไม่เคยเคลื่อนไหวในคลังไม่มีวันที่ตัดยอด
    if ('inventory_date' in data) {
      data.inventory_date = toDbDate(data.inventory_date);
    }
    await planningModel.insertPlanningTmp(db, data);
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.put('/tmp', async (req, res, next) => {
  let db = req.db;
  let _uuid = req.body.uuid;
  let data = req.body.data;

  try {
    data.uuid = _uuid;
    data.update_date = moment().format('YYYY-MM-DD HH:mm:ss');
    data.update_by = req.decoded.people_user_id;
    /**
     * ยาที่ไม่เคยมีความเคลื่อนไหวในคลังจะไม่มีวันที่ตัดยอด (NULL ได้ตามโครงสร้างตาราง
     * และมีจริง 4,535 จาก 52,747 แถว) หน้าจอเอาค่า null ไปผ่าน moment().format()
     * จึงส่งสตริง 'Invalid date' กลับมา ซึ่ง MySQL ปฏิเสธด้วย ER_TRUNCATED_WRONG_VALUE
     * หน้าจอแก้แล้ว แต่กันไว้ที่นี่ด้วย เผื่อมีที่เรียกอื่นหรือหน้าจอเวอร์ชันเก่า
     */
    if ('inventory_date' in data) {
      data.inventory_date = toDbDate(data.inventory_date);
    }
    // ผูก uuid ด้วย ไม่งั้นแก้รายการในร่างแผนของคนอื่นได้ด้วยการเดา tmp_id
    const affected = await planningModel.updatePlanningTmp(db, data.tmp_id, _uuid, data);
    if (!affected) {
      res.send({ ok: false, error: 'ไม่พบรายการที่ต้องการแก้ไข' });
      return;
    }
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.delete('/tmp/:tmpId', async (req, res, next) => {
  let db = req.db;
  let tmpId = +req.params.tmpId;
  let _uuid = req.query.uuid;

  try {
    // ผูก uuid ด้วย ไม่งั้นลบรายการในร่างแผนของคนอื่นได้ด้วยการเดา tmp_id
    if (!_uuid) {
      res.send({ ok: false, error: 'ไม่พบรายการที่ต้องการลบ' });
      return;
    }
    const affected = await planningModel.deletePlanningTmp(db, [tmpId], _uuid);
    if (!affected) {
      res.send({ ok: false, error: 'ไม่พบรายการที่ต้องการลบ' });
      return;
    }
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.delete('/', async (req, res, next) => {
  let db = req.db;
  let planningId = req.query.planningId;

  try {
    /**
     * ลบรายละเอียดด้วย ไม่งั้นแถวใน bm_planning_detail จะค้างอยู่ตลอดไป
     * ตารางไม่มี foreign key จึงไม่มี cascade ให้พึ่ง
     * (ตรวจฐาน dev แล้วพบแถวที่หัวแผนถูกลบไปแล้ว 2,783 แถว)
     */
    await db.transaction(async (trx) => {
      await planningModel.deletePlanningDetail(trx, planningId);
      await planningModel.removePlanning(trx, planningId);
    });
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

/**
 * ยืนยันแผนจากหน้ารายการ — เปลี่ยนแค่สถานะ ไม่แตะรายละเอียดแผน
 *
 * ตั้งใจไม่ใช้ PUT / เพราะเส้นทางนั้นเขียนรายละเอียดใหม่จากตารางชั่วคราว
 * ซึ่งต้องมี uuid และต้องเปิดแผนขึ้นมาแก้ก่อน ถ้าเรียกจากหน้ารายการ
 * ตารางชั่วคราวจะว่าง แล้วรายละเอียดของแผนจะถูกลบทิ้งทั้งหมด
 */
router.put('/confirm/:headerId', async (req, res, next) => {
  let db = req.db;
  let headerId = +req.params.headerId;

  try {
    if (!headerId) {
      res.send({ ok: false, error: 'ไม่พบแผนที่ต้องการยืนยัน' });
      return;
    }

    const rows: any = await planningModel.getPlanningHeaderInfo(db, headerId);
    if (!rows.length) {
      res.send({ ok: false, error: 'ไม่พบแผนที่ต้องการยืนยัน' });
      return;
    }
    if (rows[0].confirmed === 'Y') {
      res.send({ ok: false, error: 'แผนนี้ยืนยันไปแล้ว' });
      return;
    }

    await planningModel.updatePlanningHeader(db, headerId, {
      confirmed: 'Y',
      update_date: moment().format('YYYY-MM-DD HH:mm:ss'),
      update_by: req.decoded.people_user_id
    });
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/history/:headerId', async (req, res, next) => {
  let db = req.db;
  let planningHeaderId = req.params.headerId;

  try {
    let rs: any = await planningModel.getPlanningHistory(db, planningHeaderId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

const insertPlanning = (async (db: Knex, _header: any, _uuid: any, peopleUserId: any) => {
  /**
   * bgtype_id เป็น NOT NULL ไม่มีค่าเริ่มต้น (ทั้งใน mmis.sql และทุกโรงพยาบาล)
   *
   * ถ้าไม่ได้ส่งมา knex จะใส่ DEFAULT ให้แล้ว MySQL ปฏิเสธด้วย
   * ER_NO_DEFAULT_FOR_FIELD ซึ่งเป็นข้อความที่ผู้ใช้อ่านไม่รู้เรื่อง
   *
   * เกิดจริงตอนกดบันทึกแผนที่ยืนยันไปแล้ว เพราะเส้นทางนั้นสร้างแผนฉบับใหม่
   * ด้วยฟังก์ชันนี้ แต่หน้าแก้ไขไม่ได้ส่งประเภทงบมาให้
   */
  if (!_header.budgetTypeId) {
    throw new Error('ไม่พบประเภทงบประมาณของแผน กรุณาเลือกประเภทงบก่อนบันทึก');
  }

  let refHeaderId = _header.refHeaderId ? _header.refHeaderId.toString() : null;
  let header = {
    planning_year: _header.planningYear,
    planning_amount: _header.totalAmount,
    planning_name: _header.planningName,
    planning_memo: _header.planningMemo,
    planning_qty: _header.planningQty,
    ref_hdr_id: refHeaderId,
    bgtype_id: _header.budgetTypeId,
    /**
     * แผนที่สร้างใหม่ต้องรอยืนยันเสมอ รวมถึงฉบับแก้ไขของแผนที่ยืนยันไปแล้ว
     *
     * เขียนค่าลงไปตรง ๆ ไม่พึ่ง default ของคอลัมน์ ด้วยเหตุผลเดียวกับ bgtype_id
     * คือโครงสร้างตารางของแต่ละโรงพยาบาลไม่เหมือนกัน จะเชื่อ default ไม่ได้
     *
     * หน้าจอส่ง confirmed มาด้วย แต่ตั้งใจไม่ใช้ เพราะการแก้แผนที่ยืนยันแล้ว
     * ต้องผ่านการยืนยันใหม่อีกครั้งเสมอ
     */
    confirmed: 'N',
    create_date: moment().format('YYYY-MM-DD HH:mm:ss'),
    create_by: peopleUserId
  }
  let rs: any = await planningModel.insertPlanningHeader(db, header);
  let headerId = rs[0];
  await planningModel.insertPlanningDetailFromTmp(db, headerId, _uuid);

  if (refHeaderId) await planningModel.changePlanningInactive(db, refHeaderId);

  return headerId;
});

const updatePlanning = (async (db: Knex, _header: any, _uuid: any, peopleUserId: any) => {
  let _headerId = _header.planningHeaderId;
  let refHeaderId = _header.refHeaderId ? _header.refHeaderId.toString() : null;
  let header = {
    planning_year: _header.planningYear,
    planning_amount: _header.totalAmount,
    planning_name: _header.planningName,
    planning_memo: _header.planningMemo,
    confirmed: _header.confirmed,
    planning_qty: _header.planningQty,
    ref_hdr_id: refHeaderId,
    update_date: moment().format('YYYY-MM-DD HH:mm:ss'),
    update_by: peopleUserId
  }
  await planningModel.updatePlanningHeader(db, _headerId, header);
  await planningModel.deletePlanningDetail(db, _headerId);
  await planningModel.insertPlanningDetailFromTmp(db, _headerId, _uuid);

  if (refHeaderId) await planningModel.changePlanningInactive(db, refHeaderId);
});

router.post('/adjust-amount', async (req, res, next) => {
  let db = req.db;
  let _uuid = req.body.uuid;
  let _adjust = req.body.amount;

  try {
    let rs1 = await planningModel.countPlanningTmp(db, _uuid, null, null);
    let _total = rs1[0].amount || 0;
    let rs2 = await planningModel.getPlanningFreezeAmount(db, _uuid);
    let _freeze = rs2[0].amount || 0;
    let totalAmount = _total - _freeze;
    let adjustAmount = _adjust - _freeze;

    /**
     * ยอดรวมของรายการที่ปรับได้เป็นศูนย์ จะหารไม่ได้
     *
     * เกิดได้จริงเมื่อรายการทั้งหมดถูก freeze ไว้ หรือทุกรายการมียอดเป็นศูนย์
     * ถ้าปล่อยผ่าน percent จะเป็น Infinity หรือ NaN แล้วไหลไปเป็นจำนวนไตรมาส
     * ทำให้ insert พังหรือได้ค่าขยะลงฐาน
     */
    if (!+totalAmount) {
      res.send({ ok: false, error: 'ไม่มีรายการที่ปรับได้ (รายการทั้งหมดถูก Freeze ไว้ หรือยอดเงินรวมเป็นศูนย์)' });
      return;
    }

    const percent = (+adjustAmount / +totalAmount * 100) - 100;
    const _ratio = percent / 100;
    let rows: any = await planningModel.getPlanningForAdjust(db, _uuid);

    let tmpIds = [];

    for (const r of rows) {
      if (adjustAmount < 0 || r.unit_cost === 0) {
        r.q1 = 0;
        r.q2 = 0;
        r.q3 = 0;
        r.q4 = 0;
        r.qty = 0;
        r.amount = 0;
      } else {
        let _amountQ1 = r.q1 * r.unit_cost;
        let _amountQ2 = r.q2 * r.unit_cost;
        let _amountQ3 = r.q3 * r.unit_cost;
        let _amountQ4 = r.q4 * r.unit_cost;
        r.q1 = Math.floor((_amountQ1 + _amountQ1 * _ratio) / r.unit_cost);
        r.q2 = Math.floor((_amountQ2 + _amountQ2 * _ratio) / r.unit_cost);
        r.q3 = Math.floor((_amountQ3 + _amountQ3 * _ratio) / r.unit_cost);
        r.q4 = Math.floor((_amountQ4 + _amountQ4 * _ratio) / r.unit_cost);
        r.qty = r.q1 + r.q2 + r.q3 + r.q4;
        r.amount = r.qty * r.unit_cost;
      }
      tmpIds.push(r.tmp_id);
    }
    /**
     * ครอบด้วย transaction เพราะเป็นการลบทั้งชุดแล้วเขียนกลับ
     * ถ้า insert พังกลางทาง (เคยเกิดจริงจากคอลัมน์เกิน) ข้อมูลที่ลบไปแล้วจะหายถาวร
     */
    await db.transaction(async (trx) => {
      await planningModel.deletePlanningTmp(trx, tmpIds, _uuid);
      // กรองคอลัมน์ก่อน insert เหมือนกัน แม้ตอนนี้ getPlanningForAdjust จะคืนเฉพาะคอลัมน์จริงอยู่แล้ว
      // เผื่อวันหลังมีคนเปลี่ยน query แล้วพ่วงคอลัมน์เกินมาโดยไม่รู้ตัว
      await planningModel.insertPlanningTmp(trx, rows.map(r => _.pick(r, TMP_COLUMNS)));
    });
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/adjust-percent', async (req, res, next) => {
  let db = req.db;
  let _uuid = req.body.uuid;
  let percent = req.body.percent;

  try {
    let rows: any = await planningModel.getPlanningForAdjust(db, _uuid);
    /**
     * ต้องบอกให้ตรงกับ /adjust-amount
     *
     * เดิมถ้าไม่เหลือรายการให้ปรับ processAdjustPercent จะ return เฉย ๆ
     * แล้ว route ตอบ ok หน้าจอจึงขึ้นว่าสำเร็จทั้งที่ตัวเลขไม่ขยับ
     * ชวนให้เข้าใจผิดว่าระบบพัง
     *
     * เช็คที่นี่ไม่ใช่ในตัว processAdjustPercent เพราะ /copy ใช้ฟังก์ชันเดียวกัน
     * และการคัดลอกโดยไม่ใส่เปอร์เซ็นต์เป็นการใช้งานปกติ ไม่ใช่ข้อผิดพลาด
     */
    if (!rows.length) {
      res.send({ ok: false, error: 'ไม่มีรายการที่ปรับได้ (แผนไม่มีรายการ หรือรายการทั้งหมดถูก Freeze ไว้)' });
      return;
    }
    await processAdjustPercent(db, rows, percent, _uuid);
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/copy', async (req, res, next) => {
  let db = req.db;
  let planningHeaderId = req.body.headerId;
  let adjustPercent = req.body.percent || 0;
  let planningYear = req.body.year;
  let _uuid = req.body.uuid;

  try {
    // คัดลอกแผน = เริ่มงานชุดใหม่ ถือโอกาสเก็บกวาดของเก่าที่ถูกทิ้งค้างไว้
    await cleanExpiredTmp(db, _uuid);

    // ต้องส่งคลังไปด้วย ไม่งั้น join กับ bm_planning_forecast จะได้หลายแถวต่อยา 1 ตัว
    // แล้วรายการในแผนที่คัดลอกมาจะซ้ำเป็นจำนวนเท่าของคลังที่มี forecast
    let warehouseId = req.decoded.warehouseId;
    let rs: any = await planningModel.getPlanningForCopy(db, planningHeaderId, planningYear, warehouseId);
    let data = [];
    for (const r of rs) {
      let obj: any = {};
      obj.uuid = _uuid;
      obj.generic_id = r.generic_id;
      obj.generic_name = r.generic_name;
      obj.unit_generic_id = r.unit_generic_id;
      obj.unit_desc = `${r.from_unit_name} (${r.conversion_qty} ${r.to_unit_name})`;
      obj.unit_cost = r.unit_cost;
      obj.conversion_qty = r.conversion_qty;
      obj.primary_unit_id = r.primary_unit_id;
      obj.rate_1_year = Math.round(r.sumy1 / r.conversion_qty);
      obj.rate_2_year = Math.round(r.sumy2 / r.conversion_qty);
      obj.rate_3_year = Math.round(r.sumy3 / r.conversion_qty);
      obj.estimate_qty = Math.round(r.sumy4 / r.conversion_qty);
      obj.stock_qty = Math.round(r.stock_qty / r.conversion_qty);
      obj.inventory_date = toDbDate(r.process_date);
      obj.estimate_buy = Math.round(r.buy_qty / r.conversion_qty);
      obj.q1 = Math.round(r.q1 / r.conversion_qty);
      obj.q2 = Math.round(r.q2 / r.conversion_qty);
      obj.q3 = Math.round(r.q3 / r.conversion_qty);
      obj.q4 = Math.round(r.q4 / r.conversion_qty);
      obj.qty = obj.q1 + obj.q2 + obj.q3 + obj.q4;
      obj.amount = obj.qty * obj.unit_cost;
      // obj.bid_type_id = r.bid_type_id;
      // obj.bid_type_name = r.bid_type_name;
      obj.freeze = r.freeze;
      obj.create_date = moment().format('YYYY-MM-DD HH:mm:ss');
      obj.update_date = moment().format('YYYY-MM-DD HH:mm:ss');
      obj.create_by = req.decoded.people_user_id;
      obj.update_by = req.decoded.people_user_id;
      obj.generic_type_id = r.generic_type_id;
      data.push(obj);
    }
    /**
     * ทั้งชุดอยู่ใน transaction เดียว — ล้างของเดิม เขียนของใหม่ แล้วปรับเปอร์เซ็นต์
     * ถ้าขั้นไหนพัง ต้องย้อนกลับทั้งหมด ไม่ใช่เหลือครึ่งๆ กลางๆ
     */
    await db.transaction(async (trx) => {
      await planningModel.clearPlanningTmp(trx, _uuid);
      await planningModel.insertPlanningTmp(trx, data);

      /**
       * ใช้ getPlanningForAdjust ไม่ใช่ getPlanningTmp
       *
       * getPlanningTmp join ตารางอื่นแล้วพ่วง generic_code / generic_hosp_name กลับมาด้วย
       * พอส่งต่อไปให้ processAdjustPercent ที่ลบแล้วเขียนกลับ insert จะพัง
       * (ER_BAD_FIELD_ERROR) และรายการที่เพิ่งคัดลอกมาถูกลบไปแล้วทั้งหมด
       *
       * getPlanningForAdjust คืนเฉพาะคอลัมน์ของตารางจริง และกรอง freeze = 'N' ให้ด้วย
       * ตรงกับ /adjust-percent ที่รายการซึ่งถูก freeze ไว้จะไม่ถูกปรับ
       */
      let rows = await planningModel.getPlanningForAdjust(trx, _uuid);
      await processAdjustPercent(trx, rows, adjustPercent, _uuid);
    });
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

/**
 * คอลัมน์ที่มีอยู่จริงใน bm_planning_tmp
 *
 * ใช้กรองก่อน insert เสมอ เพราะบาง query (เช่น getPlanningTmp) join ตารางอื่น
 * แล้วพ่วงคอลัมน์ที่ไม่มีในตารางนี้กลับมาด้วย เช่น generic_code, generic_hosp_name
 * ถ้าเอาไป insert ตรงๆ จะได้ ER_BAD_FIELD_ERROR แล้วข้อมูลที่ลบไปก่อนหน้าหายถาวร
 */
const TMP_COLUMNS = [
  'tmp_id', 'uuid', 'planning_dtl_id', 'planning_hdr_id', 'generic_id', 'generic_name',
  'generic_type_name', 'unit_generic_id', 'unit_desc', 'unit_cost', 'conversion_qty',
  'primary_unit_id', 'rate_1_year', 'rate_2_year', 'rate_3_year', 'estimate_qty',
  'stock_qty', 'inventory_date', 'estimate_buy', 'q1', 'q2', 'q3', 'q4', 'qty', 'amount',
  'bid_type_id', 'bid_type_name', 'freeze', 'create_date', 'update_date', 'create_by',
  'update_by', 'is_edit', 'generic_type_id'
];

/** knex ตั้ง isTransaction ไว้บน object ของ transaction ใช้แยกได้ว่าอยู่ใน transaction แล้วหรือยัง */
function isTransaction(conn: any): boolean {
  return !!(conn && conn.isTransaction);
}

const processAdjustPercent = (async (db: Knex, data: any, percent: any, _uuid: any) => {
  // ปรับ 0% ไม่มีอะไรเปลี่ยน ไม่ต้องลบแล้วเขียนกลับให้เสี่ยงเปล่าๆ
  if (!data.length || !+percent) {
    return;
  }

  const _ratio = percent / 100;
  let tmpIds = [];
  let rows = [];

  for (const d of data) {
    d.q1 = Math.floor(d.q1 + (d.q1 * _ratio));
    d.q2 = Math.floor(d.q2 + (d.q2 * _ratio));
    d.q3 = Math.floor(d.q3 + (d.q3 * _ratio));
    d.q4 = Math.floor(d.q4 + (d.q4 * _ratio));
    d.qty = d.q1 + d.q2 + d.q3 + d.q4;
    d.amount = d.qty * d.unit_cost;
    tmpIds.push(d.tmp_id);
    rows.push(_.pick(d, TMP_COLUMNS));
  }

  // ลบแล้วเขียนกลับต้องอยู่ใน transaction เดียวกัน ไม่งั้นพังกลางทางแล้วข้อมูลหาย
  // ถ้าผู้เรียกส่ง transaction มาให้แล้ว ใช้ตัวนั้นต่อ ไม่เปิดซ้อนอีกชั้น
  const run = async (conn) => {
    await planningModel.deletePlanningTmp(conn, tmpIds, _uuid);
    await planningModel.insertPlanningTmp(conn, rows);
  };

  if (isTransaction(db)) {
    await run(db);
  } else {
    await db.transaction(run);
  }
});

router.get('/excel/:headerId', async (req, res, next) => {
  let db = req.db;
  let headerId = req.params.headerId;
  let _uuid = req.query.uuid;

  // เดิม route นี้ไม่มี try/catch และไม่ปิด connection
  // ผลคือทุกครั้งที่ส่งออก Excel จะมี connection ค้างใน pool
  // และถ้าไม่พบแผน (header[0] เป็น undefined) จะโยน error ออกไปที่ express
  try {
    let header: any = await planningModel.getPlanningHeaderInfo(db, headerId);
    if (!header.length) {
      res.send({ ok: false, error: 'ไม่พบแผนที่ต้องการส่งออก' });
      return;
    }
    let rows = await planningModel.getPlanningTmp(db, _uuid, null, null, null);
    let data = [];
    let i = 1;
  for (const r of rows) {
    let obj = {
      '#': i++,
      'รหัสยา': r.generic_code,
      'รายการ': r.generic_name,
      'หมวดสินค้า': r.generic_type_name,
      'ประเภทสินค้า': r.generic_hosp_name,
      'หน่วย': r.unit_desc,
      'ราคาต่อหน่วย': r.unit_cost,
      'ย้อนหลัง3ปี': r.rate_3_year,
      'ย้อนหลัง2ปี': r.rate_2_year,
      'ย้อนหลัง1ปี': r.rate_1_year,
      'ประมาณการใช้': r.estimate_qty,
      'ยอดคงคลัง': r.stock_qty,
      'ประมาณการซื้อ': r.estimate_buy,
      'งวดที่1': r.q1,
      'งวดที่2': r.q2,
      'งวดที่3': r.q3,
      'งวดที่4': r.q4,
      'จำนวนรวม': r.qty,
      'มูลค่ารวม': r.amount,
      // 'การจัดซื้อ': r.bid_type_name,
      'Freeze': r.freeze,
      /**
       * คอลัมน์สำหรับให้ระบบจับคู่ขนาดบรรจุตอนนำเข้ากลับ
       *
       * จำเป็นเพราะยา 109 กลุ่มมีขนาดบรรจุหลายรายการที่เขียนเป็นข้อความเหมือนกันเป๊ะ
       * (เช่น BOX (100 TAB) สองรายการ) ดูจากคอลัมน์ "หน่วย" อย่างเดียวแยกไม่ออก
       *
       * ตั้งชื่อให้ผู้ใช้รู้ว่าห้ามแตะ แต่ไม่ได้ซ่อน — ถ้าจะซ่อนต้องเปลี่ยนไปใช้ xlsx
       * แทน json2xls ซึ่งตกลงกันว่าไม่คุ้ม
       */
      'unit_generic_id [ระบบ] - ห้ามแก้ไข': r.unit_generic_id
    };
    data.push(obj);
  }
    let fileName = `${header[0].planning_name} ${+header[0].planning_year + 543}`;
    let xls = json2xls(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURI(fileName)}.xlsx`);
    res.end(xls, 'binary');
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

let uploadDir = './uploads';
fse.ensureDirSync(uploadDir);

var storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    let _ext = path.extname(file.originalname);
    cb(null, Date.now() + _ext)
  }
});
let upload = multer({ storage: storage });

/** ชื่อคอลัมน์ที่ export ใส่รหัสขนาดบรรจุไว้ ต้องตรงกับตอนเขียนไฟล์เป๊ะ */
const COL_UNIT_GENERIC_ID = 'unit_generic_id [ระบบ] - ห้ามแก้ไข';

/**
 * แปลงค่าจากช่อง Excel เป็นตัวเลข
 *
 * ช่องว่างต้องได้ 0 ไม่ใช่ undefined เพราะคอลัมน์อย่าง q1-q4 / qty / amount / estimate_qty
 * เป็น NOT NULL ไม่มี default ในทุกโรงพยาบาล ถ้าปล่อย undefined ไป INSERT จะพังทั้งก้อน
 * เพราะแถวเดียวที่ผู้ใช้เผลอลบค่าออก
 */
function excelNumber(value: any): number {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const n = Number(String(value).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

function excelText(value: any): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * เลือกขนาดบรรจุ เมื่อข้อความหน่วยในไฟล์ตรงกับข้อมูลหลักหลายรายการ
 * คืน null เมื่อตัวคูณแปลงหน่วยต่างกันจริง ซึ่งเดาไม่ได้
 *
 * ตัดขนาดบรรจุที่ถูกลบไปแล้วออกก่อน เพราะหน้าจอข้อมูลหลักก็ไม่แสดงเช่นกัน
 * (ฐาน dev มี 197 แถวที่ is_deleted='Y' และเป็นต้นเหตุของกลุ่มที่ซ้ำถึง 89 จาก 109 กลุ่ม)
 * แต่ถ้าเหลือแต่ของที่ถูกลบทั้งหมด ยังยอมใช้ เพื่อไม่ให้แผนเก่าที่อ้างของพวกนั้นนำเข้าไม่ได้
 *
 * ลำดับที่เลือก
 *   1. ของเดิมที่แผนใช้อยู่ — ส่งออกแล้วนำเข้ากลับต้องได้รหัสเดิม
 *   2. ขนาดบรรจุที่ตั้งไว้ที่ตัวยาสำหรับทำแผน (`planning_unit_generic_id`)
 *      ซึ่งเป็นตัวเดียวกับที่เส้นทางพยากรณ์ใช้ จึงสอดคล้องกับแผนที่สร้างจากพยากรณ์
 *   3. ที่ยังเปิดใช้งานอยู่
 *   4. รหัสน้อยสุด เพื่อให้ผลคงที่ทุกครั้ง
 */
export function pickUnitGeneric(matches: any[], currentUnitGenericId?: any,
  plannedUnitGenericId?: any): any {
  if (!matches || !matches.length) { return null; }
  const live = matches.filter(u => u.is_deleted !== 'Y');
  const candidates = live.length ? live : matches;
  if (candidates.length === 1) { return candidates[0]; }
  const conversions = _.uniq(candidates.map(u => `${u.to_unit_id}|${u.qty}`));
  if (conversions.length > 1) { return null; }
  const is = (u: any, id: any) => id !== undefined && id !== null && id !== ''
    && String(u.unit_generic_id) === String(id);
  return _.orderBy(candidates, [
    u => is(u, currentUnitGenericId) ? 0 : 1,
    u => is(u, plannedUnitGenericId) ? 0 : 1,
    u => u.is_active === 'Y' ? 0 : 1,
    u => +u.unit_generic_id
  ], ['asc', 'asc', 'asc', 'asc'])[0];
}

router.post('/excel', upload.single('file'), async (req, res, next) => {
  let db = req.db;
  let _uuid = req.query.uuid;
  let filePath = req.file.path;

  const workSheetsFromFile = xlsx.parse(`${filePath}`);

  let excelData = workSheetsFromFile[0].data;
  let maxRecord = excelData.length;

  let header = excelData[0];
  const genericCode = _.indexOf(header, 'รหัสยา');
  const sysUnitGenericId = _.indexOf(header, COL_UNIT_GENERIC_ID);
  const name = _.indexOf(header, 'รายการ');
  const unit = _.indexOf(header, 'หน่วย');
  const unitCost = _.indexOf(header, 'ราคาต่อหน่วย');
  const b3y = _.indexOf(header, 'ย้อนหลัง3ปี');
  const b2y = _.indexOf(header, 'ย้อนหลัง2ปี');
  const b1y = _.indexOf(header, 'ย้อนหลัง1ปี');
  const estimatedUse = _.indexOf(header, 'ประมาณการใช้');
  const balance = _.indexOf(header, 'ยอดคงคลัง');
  const estimatedPurchase = _.indexOf(header, 'ประมาณการซื้อ');
  const period1 = _.indexOf(header, 'งวดที่1');
  const period2 = _.indexOf(header, 'งวดที่2');
  const period3 = _.indexOf(header, 'งวดที่3');
  const period4 = _.indexOf(header, 'งวดที่4');
  const qty = _.indexOf(header, 'จำนวนรวม');
  const cost = _.indexOf(header, 'มูลค่ารวม');
  const freeze = _.indexOf(header, 'Freeze');
  if (name > -1 && unit > -1 && unitCost > -1 && b3y > -1 && b2y > -1 && b1y > -1 && estimatedUse > -1 && balance > -1 && estimatedPurchase > -1 && period1 > -1 && period2 > -1 &&
    period3 > -1 && period4 > -1 && qty > -1 && cost > -1 && freeze > -1) {

    try {
      /**
       * จับคู่รายการในหน่วยความจำแทนการ UPDATE...JOIN ด้วยชื่อยาหลัง insert
       *
       * ข้อดี 3 อย่าง
       *   1. ใช้รหัสยาเป็นกุญแจได้ ซึ่งไม่ซ้ำ ต่างจากชื่อยาที่ซ้ำกันได้จริง
       *   2. รู้ตั้งแต่ก่อน insert ว่าแถวไหนจับคู่ไม่ได้ จึงบอกผู้ใช้เป็นรายแถวได้
       *   3. ใส่ unit_generic_id / primary_unit_id / generic_type_id ได้ตั้งแต่ INSERT แรก
       *      ไม่ต้องพึ่ง default ของตาราง ทำให้ใช้ได้แม้โรงพยาบาลที่โครงสร้างตารางเพี้ยน
       */
      const generics: any = await planningModel.getGenericsForImport(db);
      const unitGenerics: any = await planningModel.getUnitGenericsForImport(db);

      const byCode = _.keyBy(generics, g => excelText(g.working_code));
      const byName = _.groupBy(generics, g => excelText(g.generic_name));
      const unitById = _.keyBy(unitGenerics, u => String(u.unit_generic_id));
      const unitsByGeneric = _.groupBy(unitGenerics, u => String(u.generic_id));

      // ขนาดบรรจุที่แผนใช้อยู่ก่อนนำเข้าทับ ใช้เป็นตัวเลือกอันดับแรกเวลาข้อความหน่วยซ้ำกัน
      const currentTmp: any = await planningModel.getPlanningTmpUnits(db, _uuid);
      const currentUnitByGeneric = _.keyBy(currentTmp, r => String(r.generic_id));

      let _data: any = [];
      let skipped: any = [];
      // ยา 1 ตัวควรมีบรรทัดเดียวในแผน ถ้าไฟล์มีซ้ำให้เก็บแถวแรกแล้วรายงานที่เหลือ
      let seenGeneric: any = {};

      for (let x = 1; x < maxRecord; x++) {
        const row = excelData[x] || [];
        // แถว excel เริ่มนับ 1 และแถวแรกเป็นหัวตาราง แถวข้อมูลแรกจึงเป็นแถวที่ 2
        const excelRow = x + 1;

        const rowName = excelText(row[name]);
        const rowUnit = excelText(row[unit]);

        // ข้ามแถวว่างท้ายไฟล์แบบเงียบๆ ไม่ต้องรายงานว่าเป็นข้อผิดพลาด
        if (!rowName && !rowUnit && (genericCode < 0 || !excelText(row[genericCode]))) {
          continue;
        }

        // --- หาตัวยา: รหัสยาก่อน แล้วค่อยถอยไปใช้ชื่อ ---
        let generic: any = null;
        if (genericCode > -1 && excelText(row[genericCode])) {
          generic = byCode[excelText(row[genericCode])] || null;
        }
        if (!generic && rowName) {
          const found = byName[rowName] || [];
          // ชื่อซ้ำกันหลายตัวแล้วไม่มีรหัสยามาช่วย ตัดสินไม่ได้ ไม่เดา
          if (found.length === 1) {
            generic = found[0];
          } else if (found.length > 1) {
            skipped.push({ row: excelRow, generic_name: rowName, unit_desc: rowUnit,
              reason: 'ชื่อยาซ้ำกันหลายรายการ ต้องระบุรหัสยา' });
            continue;
          }
        }
        if (!generic) {
          skipped.push({ row: excelRow, generic_name: rowName, unit_desc: rowUnit,
            reason: 'ไม่พบรายการยานี้ในระบบ' });
          continue;
        }

        // --- หาขนาดบรรจุ: รหัสจากคอลัมน์ระบบก่อน แล้วค่อยถอยไปใช้ข้อความหน่วย ---
        let unitGeneric: any = null;
        if (sysUnitGenericId > -1 && excelText(row[sysUnitGenericId])) {
          const candidate = unitById[excelText(row[sysUnitGenericId])];
          // ห้ามเชื่อค่าในไฟล์ ต้องเป็นขนาดบรรจุของยาตัวนี้จริงเท่านั้น
          if (candidate && String(candidate.generic_id) === String(generic.generic_id)) {
            unitGeneric = candidate;
          }
        }
        if (!unitGeneric && rowUnit) {
          const matches = (unitsByGeneric[String(generic.generic_id)] || [])
            .filter(u => excelText(u.unit_desc) === rowUnit);

          if (matches.length) {
            /**
             * ข้อมูลหลักมีขนาดบรรจุที่เขียนออกมาเหมือนกันซ้ำอยู่จริง
             * (ตรวจฐาน dev แล้วพบ 109 กลุ่ม ทุกกลุ่มมี to_unit_id และ qty เท่ากันหมด
             *  ต่างกันแค่ราคาและตัวรหัสเอง ซึ่งราคาไม่ได้ใช้เพราะอ่าน unit_cost จากไฟล์)
             *
             * ถ้าตัวคูณแปลงหน่วยเท่ากันทุกตัว จะเลือกตัวไหนก็ให้ผลเหมือนกัน
             * ปฏิเสธไปทั้งแถวคือทำให้ยาตัวนั้นหายจากแผน ทั้งที่ไฟล์ไม่ได้ผิดอะไร
             *
             * เหลือปฏิเสธเฉพาะกรณีที่ตัวคูณต่างกันจริง ซึ่งเลือกผิดแล้วจำนวนจะเพี้ยน
             */
            const current = currentUnitByGeneric[String(generic.generic_id)];
            unitGeneric = pickUnitGeneric(matches, current && current.unit_generic_id,
              generic.planning_unit_generic_id);
            if (!unitGeneric) {
              skipped.push({ row: excelRow, generic_name: rowName, unit_desc: rowUnit,
                reason: 'ยานี้มีขนาดบรรจุที่เขียนเหมือนกันแต่ตัวคูณต่างกัน แยกไม่ออก' });
              continue;
            }
          }
        }
        if (!unitGeneric) {
          skipped.push({ row: excelRow, generic_name: rowName, unit_desc: rowUnit,
            reason: 'ไม่พบขนาดบรรจุนี้ของยารายการนี้' });
          continue;
        }

        const genericKey = String(generic.generic_id);
        if (seenGeneric[genericKey]) {
          skipped.push({ row: excelRow, generic_name: rowName, unit_desc: rowUnit,
            reason: `ยาซ้ำกับแถวที่ ${seenGeneric[genericKey]} ในไฟล์เดียวกัน` });
          continue;
        }
        seenGeneric[genericKey] = excelRow;

        const q1 = excelNumber(row[period1]);
        const q2 = excelNumber(row[period2]);
        const q3 = excelNumber(row[period3]);
        const q4 = excelNumber(row[period4]);
        const unitCostValue = excelNumber(row[unitCost]);
        const totalQty = q1 + q2 + q3 + q4;

        _data.push({
          uuid: _uuid,
          generic_id: generic.generic_id,
          generic_name: generic.generic_name,
          generic_type_id: generic.generic_type_id,
          unit_generic_id: unitGeneric.unit_generic_id,
          primary_unit_id: unitGeneric.to_unit_id,
          conversion_qty: unitGeneric.qty,
          unit_desc: unitGeneric.unit_desc,
          unit_cost: unitCostValue,
          rate_3_year: excelNumber(row[b3y]),
          rate_2_year: excelNumber(row[b2y]),
          rate_1_year: excelNumber(row[b1y]),
          estimate_qty: excelNumber(row[estimatedUse]),
          stock_qty: excelNumber(row[balance]),
          estimate_buy: excelNumber(row[estimatedPurchase]),
          q1: q1, q2: q2, q3: q3, q4: q4,
          // คำนวณใหม่เสมอ ไม่เชื่อค่าในไฟล์ เผื่อผู้ใช้แก้งวดแล้วลืมแก้ยอดรวม
          qty: totalQty,
          amount: totalQty * unitCostValue,
          freeze: excelText(row[freeze]) === 'Y' ? 'Y' : 'N',
          create_by: req.decoded.people_user_id
        });
      }

      if (!_data.length) {
        res.send({ ok: false, error: 'ไม่พบข้อมูลที่นำเข้าได้', skipped: skipped });
        return;
      }

      /**
       * ล้างของเดิมกับเขียนของใหม่ต้องอยู่ในทรานแซกชันเดียวกัน
       * เส้นทางนี้เสี่ยงที่สุดเพราะเขียนทีละหลายร้อยแถว ถ้าพังกลางทาง
       * ร่างแผนเดิมจะหายทั้งชุดโดยที่ไฟล์ที่นำเข้าก็ยังไม่ได้เข้า
       */
      await db.transaction(async (trx) => {
        await planningModel.clearPlanningTmp(trx, _uuid);
        await planningModel.insertPlanningTmp(trx, _data);
      });
      // ไม่มีขั้นจับคู่หลัง insert อีกแล้ว — จับคู่เสร็จตั้งแต่ก่อนเขียนลงฐาน
      // (ฟังก์ชัน updatePlanningTmpAfterUpload ที่จับคู่ด้วยชื่อยาถูกลบออกแล้ว)

      res.send({ ok: true, imported: _data.length, skipped: skipped });
    } catch (error) {
      res.send({ ok: false, error: error.message });
    } finally {
      rimraf.sync(filePath);
      db.destroy();
    }
  } else {
    rimraf.sync(filePath);
    res.send({ ok: false, error: 'Header ไม่ถูกต้อง' })
  }

});

router.post('/merge', async (req, res, next) => {
  let db = req.db;
  let planningHeaderIds = req.body.headerIds;
  let _uuid = req.body.uuid;

  try {
    let rs: any = await planningModel.getPlanningDetailForMerge(db, planningHeaderIds);
    let data = [];
    for (const r of rs) {
      let obj: any = {};
      obj.uuid = _uuid;
      obj.generic_id = r.generic_id;
      obj.generic_name = r.generic_name;
      obj.unit_generic_id = r.unit_generic_id;
      obj.unit_desc = `${r.from_unit_name} (${r.conversion_qty} ${r.to_unit_name})`;
      obj.unit_cost = r.unit_cost;
      obj.conversion_qty = r.conversion_qty;
      obj.primary_unit_id = r.primary_unit_id;
      obj.rate_1_year = Math.round(r.rate_1_year / r.conversion_qty);
      obj.rate_2_year = Math.round(r.rate_2_year / r.conversion_qty);
      obj.rate_3_year = Math.round(r.rate_3_year / r.conversion_qty);
      obj.estimate_qty = Math.round(r.estimate_qty / r.conversion_qty);
      obj.stock_qty = Math.round(r.stock_qty / r.conversion_qty);
      obj.inventory_date = toDbDate(r.inventory_date);
      obj.estimate_buy = Math.round(r.estimate_buy / r.conversion_qty);
      obj.q1 = Math.round(r.q1 / r.conversion_qty);
      obj.q2 = Math.round(r.q2 / r.conversion_qty);
      obj.q3 = Math.round(r.q3 / r.conversion_qty);
      obj.q4 = Math.round(r.q4 / r.conversion_qty);
      obj.qty = obj.q1 + obj.q2 + obj.q3 + obj.q4;
      obj.amount = obj.qty * obj.unit_cost;
      // obj.bid_type_id = r.bid_type_id;
      // obj.bid_type_name = r.bid_type_name;
      obj.freeze = r.freeze;
      obj.create_date = toDbDate(r.create_date);
      obj.update_date = toDbDate(r.update_date);
      obj.create_by = r.create_by;
      obj.update_by = r.update_by;
      obj.generic_type_id = r.generic_type_id;
      data.push(obj);
    }
    /**
     * ล้างของเดิมกับเขียนของใหม่ต้องอยู่ในทรานแซกชันเดียวกัน
     * ถ้า insert พังกลางทาง ร่างแผนที่ทำค้างไว้จะหายถาวรเพราะลบไปก่อนแล้ว
     */
    await db.transaction(async (trx) => {
      await planningModel.clearPlanningTmp(trx, _uuid);
      await planningModel.insertPlanningTmp(trx, data);
    });
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/report/:headerId', async (req, res, next) => {
  let db = req.db;
  let headerId = req.params.headerId;
  let _uuid = req.query.uuid;

  // เดิม route นี้ไม่มี try/catch และไม่ปิด connection เช่นเดียวกับ /excel
  try {
    let hosdetail: any = await reportModel.hospital(db);
    let hospitalName = hosdetail.length ? hosdetail[0].hospname : '';
    // let planning = await planningModel.getPlanningReport(db, headerId);
    let header: any = await planningModel.getPlanningHeaderInfo(db, headerId);
    if (!header.length) {
      res.send({ ok: false, error: 'ไม่พบแผนที่ต้องการพิมพ์รายงาน' });
      return;
    }
    let rs = await planningModel.getPlanningTmp(db, _uuid, null, null, null);
    moment.locale('th');

  rs.forEach(value => {
    value.unit_cost = reportModel.comma(value.unit_cost);
    value.amount = reportModel.comma(value.amount);

    value.estimate_qty = reportModel.commaQty(value.estimate_qty);
    value.stock_qty = reportModel.commaQty(value.stock_qty);
    value.estimate_buy = reportModel.commaQty(value.estimate_buy);
    value.rate_3_year = reportModel.commaQty(value.rate_3_year);
    value.rate_2_year = reportModel.commaQty(value.rate_2_year);
    value.rate_1_year = reportModel.commaQty(value.rate_1_year);
    value.q1 = reportModel.commaQty(value.q1);
    value.q2 = reportModel.commaQty(value.q2);
    value.q3 = reportModel.commaQty(value.q3);
    value.q4 = reportModel.commaQty(value.q4);
    value.qty = reportModel.commaQty(value.qty);
  })

  let today = moment(new Date()).format('D MMMM ') + (moment(new Date()).get('year') + 543);
  let todayAmount = moment(new Date()).format('MMM ') + (moment(new Date()).get('year') + 543);
    res.render('planning', {
      hospitalName: hospitalName,
      planningYear: +header[0].planning_year + 543,
      today: today,
      planning: rs,
      todayAmount: todayAmount
    });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/clear-tmp', async (req, res, next) => {
  let db = req.db;
  let _uuid = req.body.uuid;

  try {
    let rs: any = await planningModel.clearPlanningTmp(db, _uuid);
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

export default router;