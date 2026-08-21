import * as Knex from 'knex';
import * as moment from 'moment';

export default class PlanningModel {

  getPlanningHeader(knex: Knex, planningYaer: any, planningStatus: any, planningName: any) {
    let sql = knex('bm_planning_header as ph')
      .where('ph.is_active', 'Y');
    if (planningYaer) {
      sql.andWhere('ph.planning_year', planningYaer);
    }
    if (planningStatus) {
      sql.andWhere('confirmed', planningStatus);
    }
    if (planningName) {
      let _name = `${planningName}%`;
      sql.andWhere('ph.planning_name', 'like', _name)
    }
    return sql.orderBy('ph.planning_year', 'desc');
  }

  getPlanningHeaderInfo(knex: Knex, planningHeaderId: any) {
    return knex('bm_planning_header as ph')
      .where('planning_hdr_id', planningHeaderId);
  }

  insertPlanningHeader(knex: Knex, data: any) {
    return knex('bm_planning_header')
      .insert(data);
  }

  updatePlanningHeader(knex: Knex, headerId, data) {
    return knex('bm_planning_header')
      .where('planning_hdr_id', headerId)
      .update(data);
  }

  /**
   * แผนฉบับที่ยังใช้งานอยู่ (ไม่ใช่ประวัติ) ที่ปีและชื่อตรงกัน
   * ใช้กันไม่ให้สร้างแผนชื่อซ้ำในปีเดียวกัน
   *
   * ต้องกรอง is_active ด้วย ไม่ใช่แค่ history_hdr_id
   * เพราะการรวมแผนปิดแผนต้นทางด้วย is_active='N' แต่ไม่ได้ตั้ง history_hdr_id
   * แผนพวกนั้นจึงหายจากหน้ารายการแต่ยังค้างอยู่ในฐาน
   * ถ้าไม่กรอง ผู้ใช้จะตั้งชื่อซ้ำกับแผนที่ตัวเองมองไม่เห็นไม่ได้ แล้วงงว่าทำไม
   */
  findActivePlanningByName(knex: Knex, planningYear: any, planningName: any) {
    return knex('bm_planning_header')
      .select('planning_hdr_id')
      .where('planning_year', planningYear)
      .andWhere('planning_name', planningName)
      .andWhere('is_active', 'Y')
      .whereNull('history_hdr_id')
      .limit(1);
  }

  /**
   * ค้นด้วย ปี + ชื่อแผน ซึ่ง "ไม่ unique" ในความเป็นจริง
   *
   * เส้นทางสร้างแผนใหม่ (POST /) ไม่ได้ปิดแผนเดิมที่ชื่อและปีซ้ำกัน
   * จึงมีแผนชื่อเดียวกันปีเดียวกันได้หลายฉบับพร้อมกัน
   * (ตรวจฐาน dev แล้วพบ "จัดซื้อยา" ปี 2020 มี 2 ฉบับที่ยังใช้งานอยู่)
   *
   * ผู้เรียกใช้ result[0].confirmed ตัดสินว่าจะแก้ทับหรือสร้างฉบับใหม่
   * ถ้าไม่เรียงลำดับ MySQL จะคืนแถวไหนก็ได้ ผลลัพธ์จึงไม่แน่นอน
   * เรียงจากฉบับล่าสุดไว้ก่อน เพื่อให้ตัดสินจากสถานะของฉบับที่ใหม่ที่สุดเสมอ
   */
  checkPlanningConfirm(knex: Knex, planningYear: any, planningName: any) {
    return knex('bm_planning_header as ph')
      .select('confirmed')
      .where('planning_year', planningYear)
      .andWhere('planning_name', planningName)
      .whereNull('history_hdr_id')
      .orderBy('planning_hdr_id', 'desc');
  }

  updatePlanningInactive(knex: Knex, planningYear: any, planningName: any, planningHeaderId: any) {
    return knex('bm_planning_header as ph')
      .update({
        'is_active': 'N',
        'history_hdr_id': planningHeaderId
      })
      .whereNot('planning_hdr_id', planningHeaderId)
      .andWhere('planning_year', planningYear)
      .andWhere('planning_name', planningName);
  }

  changePlanningInactive(knex: Knex, headerIds: any) {
    var _ids = headerIds.split(',');
    return knex('bm_planning_header as ph')
      .update({
        'is_active': 'N'
      })
      .whereIn('planning_hdr_id', _ids);
  }

  deletePlanningHeader(knex: Knex, headerId) {
    return knex('bm_planning_header')
      .where('planning_hdr_id', headerId)
      .del();
  }

  getPlanningDetail(knex: Knex, headerId: any) {
    return knex('bm_planning_detail as pd')
      .select('pd.*', 'mg.generic_name', 'mg.generic_type_id'
        // , 'bt.bid_name as bid_type_name'
        // , knex.raw(`CONCAT(uf.unit_name, ' (', ug.qty, ' ', ut.unit_name, ')') as unit_desc`)
        , 'uf.unit_name as from_unit_name', 'ut.unit_name as to_unit_name', 'ug.qty as conversion_qty'
        , 'gt.generic_type_name', 'ga.account_name')
      .join('mm_generics as mg', 'mg.generic_id', 'pd.generic_id')
      // .join('l_bid_type as bt', 'bt.bid_id', 'pd.bid_type_id')
      .join('mm_unit_generics as ug', 'ug.unit_generic_id', 'pd.unit_generic_id')
      .join('mm_units as uf', 'uf.unit_id', 'ug.from_unit_id')
      .join('mm_units as ut', 'ut.unit_id', 'ug.to_unit_id')
      .join('mm_generic_types as gt', 'gt.generic_type_id', 'mg.generic_type_id')
      .leftJoin('mm_generic_accounts as ga', 'ga.account_id', 'mg.account_id')
      .where('planning_hdr_id', headerId);
  }

  /**
   * !! ต้องกรอง warehouse_id ด้วยเสมอ
   *
   * bm_planning_forecast มี primary key เป็น (generic_id, warehouse_id, forecast_year)
   * ยาตัวเดียวกันจึงมีได้หลายแถวในปีเดียวกัน แถวละคลัง
   * (ตรวจฐาน dev แล้วมี 2 คลัง และยา 2,476 จาก 2,480 ตัวมีครบทั้งสองคลัง)
   *
   * ถ้า join โดยไม่กรองคลัง รายการเดียวจะไปเจอ forecast หลายแถว
   * แล้วรายการยาในแผนที่คัดลอกมาจะซ้ำเป็นจำนวนเท่าของคลัง
   *
   * getForecastList() และ getForecast() กรองคลังอยู่แล้ว ที่นี่คือจุดเดียวที่ตกหล่น
   */
  getPlanningForCopy(knex: Knex, headerId: any, planningYear: any, warehouseId: any) {
    return knex('bm_planning_detail as pd')
      .select('mg.generic_name', 'mg.generic_type_id'
        , 'pd.generic_id', 'pd.unit_generic_id', 'pd.unit_cost', 'pd.primary_unit_id'
        , 'pd.q1', 'pd.q2', 'pd.q3', 'pd.q4', 'pd.qty', 'pd.freeze'
        , 'pf.sumy1', 'pf.sumy2', 'pf.sumy3', 'pf.sumy4', 'pf.stock_qty', 'pf.process_date', 'pf.buy_qty'
        // , 'bt.bid_name as bid_type_name'
        // , knex.raw(`CONCAT(uf.unit_name, ' (', ug.qty, ' ', ut.unit_name, ')') as unit_desc`)
        , 'uf.unit_name as from_unit_name', 'ut.unit_name as to_unit_name', 'ug.qty as conversion_qty'
        , 'gt.generic_type_name', 'ga.account_name')
      .join('mm_generics as mg', 'mg.generic_id', 'pd.generic_id')
      // .join('l_bid_type as bt', 'bt.bid_id', 'pd.bid_type_id')
      .join('mm_unit_generics as ug', 'ug.unit_generic_id', 'pd.unit_generic_id')
      .join('mm_units as uf', 'uf.unit_id', 'ug.from_unit_id')
      .join('mm_units as ut', 'ut.unit_id', 'ug.to_unit_id')
      .join('mm_generic_types as gt', 'gt.generic_type_id', 'mg.generic_type_id')
      // ผูกค่าเป็นพารามิเตอร์ ไม่ต่อสตริง — planningYear มาจาก req.body ของผู้ใช้
      .joinRaw('join bm_planning_forecast as pf on pf.generic_id = pd.generic_id and pf.forecast_year = ? and pf.warehouse_id = ? ', [planningYear, warehouseId])
      .leftJoin('mm_generic_accounts as ga', 'ga.account_id', 'mg.account_id')
      .where('planning_hdr_id', headerId);
  }

  insertPlanningDetail(knex: Knex, data: any) {
    return knex('bm_planning_detail')
      .insert(data);
  }

  /**
   * !! หน่วยของข้อมูลในตารางนี้ไม่เหมือนกันทุกคอลัมน์ — อ่านก่อนเขียน query ใหม่
   *
   * จำนวนทั้งหมด (q1-q4, qty, estimate_qty, stock_qty, estimate_buy, rate_*)
   * ถูกคูณ conversion_qty ตอนบันทึก จึงเก็บเป็น "หน่วยย่อย" (เช่น เม็ด)
   *
   * แต่ unit_cost และ amount ไม่ถูกแปลง ยังเป็น "หน่วยบรรจุ" (เช่น กล่อง)
   *
   *   ผู้ใช้กรอก 20 กล่อง x 250 บาท/กล่อง = 5,000 บาท   (1 กล่อง = 25 เม็ด)
   *   เก็บลงฐาน  qty = 500 (เม็ด) · unit_cost = 250 (ต่อกล่อง) · amount = 5,000
   *
   * ผลคือ qty x unit_cost != amount ในยาที่ขนาดบรรจุมากกว่า 1
   * (ตรวจบนฐาน dev แล้ว 659 จาก 676 แถวที่ขนาดบรรจุ > 1 เป็นแบบนี้)
   *
   * ทุกหน้าจอและรายงานในระบบใช้ amount ตรงๆ หรือคำนวณใหม่จากหน่วยบรรจุ จึงยังแสดงถูกต้อง
   * แต่ใครก็ตามที่เขียน query ใหม่แล้วคูณ qty x unit_cost เองจะได้ตัวเลขผิด
   *
   * ตัดสินใจไว้ (2026-08-13) ว่ายังไม่แก้ เพราะต้องแปลงข้อมูลที่บันทึกไปแล้วของทุกโรงพยาบาล
   * ถ้าจะแก้ ต้องสำรวจก่อนว่ามีโมดูลไหนอ่าน qty/amount จากตารางนี้บ้าง
   */
  insertPlanningDetailFromTmp(knex: Knex, headerId: any, _uuid: any) {
    let sql = `
      insert into bm_planning_detail (
        planning_hdr_id, generic_id, unit_generic_id, unit_cost, primary_unit_id
        , rate_1_year, rate_2_year, rate_3_year, estimate_qty, stock_qty
        , inventory_date, estimate_buy, q1, q2, q3
        , q4, qty, amount, freeze
        , create_date, update_date, create_by, update_by
      )
      select ?, generic_id, unit_generic_id, unit_cost, primary_unit_id
            , (rate_1_year*conversion_qty), (rate_2_year*conversion_qty), (rate_3_year*conversion_qty), (estimate_qty*conversion_qty), (stock_qty*conversion_qty)
            , inventory_date, (estimate_buy*conversion_qty), (q1*conversion_qty), (q2*conversion_qty), (q3*conversion_qty)
            , (q4*conversion_qty), (qty*conversion_qty), amount, freeze
            , create_date, update_date, create_by, update_by
      from bm_planning_tmp
      where uuid = ? and generic_id != '' group by generic_id
    `;
    return knex.raw(sql, [headerId, _uuid]);
  }

  updatePlanningDetail(knex: Knex, detailId, data) {
    return knex('bm_planning_detail')
      .where('planning_dtl_id', detailId)
      .update(data);
  }

  deletePlanningDetail(knex: Knex, headerId) {
    return knex('bm_planning_detail')
      .where('planning_hdr_id', headerId)
      .del();
  }

  getPlanningYear(knex: Knex) {
    return knex('bm_planning_header')
      .distinct('planning_year')
      .select('planning_year');
  }

  getForecast(knex: Knex, genericId: any, forecastYear: any, tmpId: any, warehouseId: any) {
    if (tmpId) { //edit row
      return knex('bm_planning_forecast as pf')
        .select('pf.*', knex.raw('IFNULL(pt.q1 * pt.conversion_qty, pf.y4q1) as y4q1')
          , knex.raw('IFNULL(pt.q2 * pt.conversion_qty, pf.y4q2) as y4q2')
          , knex.raw('IFNULL(pt.q3 * pt.conversion_qty, pf.y4q3) as y4q3')
          , knex.raw('IFNULL(pt.q4 * pt.conversion_qty, pf.y4q4) as y4q4'))
        // route แปลง tmpId เป็นตัวเลขมาแล้ว (+tmpId) จึงไม่ใช่ช่องโหว่
        // แต่ผูกค่าเป็นพารามิเตอร์ไว้ด้วย จะได้ไม่ต้องพึ่งว่าผู้เรียกทุกที่จะแปลงให้เสมอ
        .joinRaw('left join bm_planning_tmp as pt on pt.generic_id = pf.generic_id and pt.tmp_id = ?', [tmpId])
        .where('pf.generic_id', genericId)
        // ต้องกรองคลังเหมือนสาขา "เพิ่มรายการใหม่" ด้านล่าง
        // bm_planning_forecast เก็บคลังละแถว ถ้าไม่กรองจะได้หลายแถวแล้วหน้าจอหยิบ rows[0]
        // ซึ่งอาจเป็นค่าของคลังอื่น ทำให้อัตราใช้ ยอดคงคลัง และประมาณการซื้อผิดคลัง
        .andWhere('pf.warehouse_id', warehouseId)
        .andWhere('pf.forecast_year', forecastYear);
    } else { //new row
      return knex('bm_planning_forecast as pf')
        .where('pf.generic_id', genericId)
        .andWhere('pf.warehouse_id', warehouseId)
        .andWhere('pf.forecast_year', forecastYear);
    }
  }

  getPlanningHistory(knex: Knex, headerId: any) {
    return knex('bm_planning_header as ph')
      .whereNot('ph.planning_hdr_id', headerId)
      .andWhere('ph.history_hdr_id', headerId)
      .orderBy('ph.planning_hdr_id', 'desc');
  }

  /**
   * planningYear มาจาก req.body ของผู้ใช้ ต้องผูกเป็นพารามิเตอร์
   * เดิมต่อเข้าสตริงตรงๆ ซึ่งสั่งคำสั่งที่สองต่อท้ายได้เพราะ multipleStatements เปิดอยู่
   */
  callForecast(knex: Knex, planningYear: any, warehouseId: any) {
    // procedure รับ INT ทั้งสองตัว แปลงเป็นตัวเลขก่อนผูกค่า
    // จะได้ส่งชนิดข้อมูลตรงกับของเดิมเป๊ะ และค่าที่ไม่ใช่ตัวเลขถูกปฏิเสธตั้งแต่ต้นทาง
    return knex.raw('call forecast_v2(?, ?)', [+planningYear, +warehouseId]);
  }

  getForecastList(knex: Knex, forecastYear: any, _genericGroups: any[], warehouseId: any) {
    let query = knex('bm_planning_forecast as pf')
      .select('pf.*', 'mg.generic_name', 'ug.to_unit_id', 'mg.generic_type_id'
        , 'uf.unit_name as from_unit_name', 'ut.unit_name as to_unit_name', 'ug.qty as conversion_qty'
        , 'ug.cost', 'mg.planning_freeze', 'mg.planning_unit_generic_id', 'mg.planning_method')
      .join('mm_generics as mg', 'mg.generic_id', 'pf.generic_id')
      // .join('l_bid_type as bt', 'bt.bid_id', 'mg.planning_method')
      .join('mm_unit_generics as ug', 'ug.unit_generic_id', 'mg.planning_unit_generic_id')
      .join('mm_units as uf', 'uf.unit_id', 'ug.from_unit_id')
      .join('mm_units as ut', 'ut.unit_id', 'ug.to_unit_id')
      .where('pf.forecast_year', forecastYear)
      .andWhere('pf.warehouse_id', warehouseId)
      .andWhere('mg.is_planning', 'Y')
      .andWhere('mg.is_active', 'Y')
      .andWhere('mg.mark_deleted', 'N');
    if (_genericGroups) {
      query.whereIn('mg.generic_type_id', _genericGroups);
    }
    return query;
  }

  insertPlanningTmp(knex: Knex, data: any) {
    return knex('bm_planning_tmp')
      .insert(data);
  }

  /**
   * ต้องผูก uuid ด้วยเสมอ ไม่ใช่ tmp_id อย่างเดียว
   *
   * tmp_id เป็น auto_increment ที่เดาได้ ส่วน uuid เป็นค่าสุ่มประจำร่างแผนของแต่ละคน
   * ถ้าผูกด้วย tmp_id อย่างเดียว ผู้ใช้ที่ยิง API เองจะแก้หรือลบรายการ
   * ในร่างแผนของคนอื่นได้ และเส้นทาง update ยังเขียน uuid ทับ
   * เท่ากับย้ายรายการของคนอื่นมาเป็นของตัวเอง
   */
  updatePlanningTmp(knex: Knex, id: any, uuid: any, data: any) {
    return knex('bm_planning_tmp')
      .where('tmp_id', id)
      .andWhere('uuid', uuid)
      .update(data);
  }

  deletePlanningTmp(knex: Knex, id: any[], uuid: any) {
    return knex('bm_planning_tmp')
      .whereIn('tmp_id', id)
      .andWhere('uuid', uuid)
      .delete();
  }

  removePlanning(knex: Knex, id: any) {
    return knex('bm_planning_header')
      .where('planning_hdr_id', id)
      .delete();
  }

  clearPlanningTmp(knex: Knex, _uuid: any) {
    return knex('bm_planning_tmp')
      .where('uuid', _uuid)
      .delete();
  }

  getPlanningTmp(knex: Knex, _uuid: any, query: any, genericType: any, limit: number, offset: number = 0) {
    let sql = knex('bm_planning_tmp as b')
      .select('b.*', 'mg.working_code as generic_code', 'mgh.name as generic_hosp_name')
      .join('mm_generics as mg', 'b.generic_id', 'mg.generic_id')
      .leftJoin('mm_generic_hosp as mgh', 'mg.generic_hosp_id', 'mgh.id')
      .where('b.uuid', _uuid);
    if (query) {
      let _query = `%${query}%`;
      sql.andWhere('b.generic_name', 'like', _query);
    }
    if (genericType) {
      sql.andWhere('b.generic_type_id', genericType);
    }
    if (limit) {
      sql.limit(limit);
    }
    sql.offset(offset);
    return sql;
  }

  /**
   * ต้อง join mm_generics เหมือน getPlanningTmp
   *
   * เดิมไม่ join ทำให้จำนวนกับยอดเงินนับรวมแถวที่ generic_id ว่าง (จับคู่ไม่ได้)
   * ซึ่ง getPlanningTmp กรองทิ้งเพราะใช้ inner join — ผลคือท้ายตารางบอก 722 รายการ
   * แต่แสดงจริง 700 และยอดเงินรวมนับรายการที่ผู้ใช้มองไม่เห็นและแก้ไขไม่ได้
   */
  countPlanningTmp(knex: Knex, _uuid: any, query: any, genericType: any) {
    let sql = knex('bm_planning_tmp as b')
      .count('* as total')
      .sum('b.amount as amount')
      .join('mm_generics as mg', 'b.generic_id', 'mg.generic_id')
      .where('b.uuid', _uuid);
    if (query) {
      let _query = `%${query}%`;
      sql.andWhere('b.generic_name', 'like', _query);
    }
    if (genericType) {
      sql.andWhere('b.generic_type_id', genericType);
    }
    return sql;
  }

  /**
   * ตัดแถวที่จับคู่ไม่ได้ออกด้วย ให้ตรงกับที่หน้าจอเห็นและกับ countPlanningTmp
   * แถวพวกนั้นถูกทิ้งตอนบันทึกแผนอยู่แล้ว (insertPlanningDetailFromTmp กรอง generic_id != '')
   * การเอาไปคิดยอดหรือปรับแผนจึงไม่มีประโยชน์และทำให้สัดส่วนการปรับเพี้ยน
   */
  getPlanningForAdjust(knex: Knex, _uuid: any) {
    return knex('bm_planning_tmp')
      .where('uuid', _uuid)
      .andWhere('freeze', 'N')
      .whereNot('generic_id', '');
  }

  getPlanningFreezeAmount(knex: Knex, _uuid: any) {
    return knex('bm_planning_tmp')
      .sum('amount as amount')
      .where('uuid', _uuid)
      .andWhere('freeze', 'Y')
      .whereNot('generic_id', '');
  }

  /** ใช้ตรวจก่อนเพิ่มรายการ ว่ายาตัวนี้มีอยู่ในแผนที่กำลังทำอยู่แล้วหรือยัง */
  findPlanningTmpByGeneric(knex: Knex, _uuid: any, genericId: any) {
    return knex('bm_planning_tmp')
      .select('tmp_id', 'generic_name')
      .where('uuid', _uuid)
      .andWhere('generic_id', genericId)
      .limit(1);
  }

  /**
   * รายการยาทั้งหมดสำหรับจับคู่ตอนนำเข้า Excel
   *
   * ใช้ working_code (รหัสยา) เป็นกุญแจหลัก ไม่ใช่ generic_name
   * เพราะชื่อยาซ้ำกันได้จริง ทำให้จับคู่ได้หลายแถวแล้วหยิบมาผิดตัวโดยไม่มีอะไรฟ้อง
   * ส่วน working_code ไม่ซ้ำและไม่ว่าง
   */
  getGenericsForImport(knex: Knex) {
    return knex('mm_generics')
      .select('generic_id', 'working_code', 'generic_name', 'generic_type_id',
        'planning_unit_generic_id')
      .where('mark_deleted', 'N');
  }

  /**
   * ขนาดบรรจุทั้งหมด พร้อมข้อความหน่วยในรูปแบบเดียวกับที่ export ออกไป
   * ต้องตรงกับที่ routes ประกอบไว้: `${from_unit_name} (${qty} ${to_unit_name})`
   */
  getUnitGenericsForImport(knex: Knex) {
    return knex('mm_unit_generics as ug')
      .select('ug.unit_generic_id', 'ug.generic_id', 'ug.to_unit_id', 'ug.qty',
        'ug.is_active', 'ug.is_deleted',
        knex.raw(`concat(fu.unit_name, ' ', '(', ug.qty, ' ', tu.unit_name, ')') as unit_desc`))
      .join('mm_units as fu', 'fu.unit_id', 'ug.from_unit_id')
      .join('mm_units as tu', 'tu.unit_id', 'ug.to_unit_id');
  }

  /**
   * เก็บกวาดร่างแผนที่ถูกทิ้งค้างไว้
   *
   * uuid ถูกสร้างใหม่ทุกครั้งที่เปิดหน้าสร้างหรือหน้าแก้ไข และหน้าแก้ไข
   * คัดลอกรายละเอียดแผนลง tmp ตั้งแต่ตอนเปิด ถ้าผู้ใช้ปิดแท็บไปเฉย ๆ
   * แถวชุดนั้นจะค้างถาวรเพราะไม่มีใครล้าง
   * (ตรวจฐาน dev แล้วพบ 66% ของตารางเป็นของที่ค้างมาเกิน 1 ปี เก่าสุดปี 2018)
   *
   * วัดอายุจาก update_date ซึ่งเป็น timestamp ที่มี on update CURRENT_TIMESTAMP
   * จึงขยับเองทุกครั้งที่มีการแก้แถวนั้น ใครยังทำงานค้างอยู่จะไม่ถูกลบ
   *
   * ลบทีละก้อนด้วย limit ไม่ลบรวดเดียว เพราะครั้งแรกจะเจอของเก่าหลายหมื่นแถว
   * ปล่อยให้ทยอยหมดไปเองจากการใช้งานปกติ จะได้ไม่ต้องไปรัน SQL ที่โรงพยาบาลทุกแห่ง
   */
  clearExpiredPlanningTmp(knex: Knex, currentUuid: any, days: number, limit: number) {
    const sql = `
      delete from bm_planning_tmp
      where update_date < now() - interval ? day
        and (uuid is null or uuid <> ?)
      limit ?`;
    return knex.raw(sql, [days, currentUuid || '', limit]);
  }

  /**
   * นับเฉพาะแถวที่จะถูกบันทึกลงแผนจริง
   *
   * ต้องกรอง generic_id != '' ให้ตรงกับเงื่อนไขใน insertPlanningDetailFromTmp
   * ไม่งั้นจะนับแถวที่จับคู่ไม่ได้รวมเข้าไปด้วย แล้วปล่อยให้บันทึกเป็นแผนเปล่าผ่านไป
   */
  countPlanningTmpForSave(knex: Knex, _uuid: any) {
    return knex('bm_planning_tmp')
      .count('* as total')
      .where('uuid', _uuid)
      .whereNot('generic_id', '');
  }

  /**
   * ขนาดบรรจุที่แต่ละตัวยาใช้อยู่ในแผนก่อนนำเข้าทับ
   * ใช้เลือกให้ตรงของเดิม เมื่อไฟล์ไม่มีคอลัมน์ [ระบบ] มาช่วยระบุ
   */
  getPlanningTmpUnits(knex: Knex, uuid: any) {
    return knex('bm_planning_tmp')
      .select('generic_id', 'unit_generic_id')
      .where('uuid', uuid);
  }


  getPlanningDetailForMerge(knex: Knex, headerIds: any[]) {
    return knex('bm_planning_detail as pd')
      .select('pd.*', knex.raw('sum(pd.q1) as q1'), knex.raw('sum(pd.q2) as q2')
        , knex.raw('sum(pd.q3) as q3'), knex.raw('sum(pd.q4) as q4')
        , knex.raw('sum(pd.qty) as qty'), knex.raw('sum(pd.amount) as amount')
        , 'mg.generic_name', 'mg.generic_type_id'
        , 'uf.unit_name as from_unit_name', 'ut.unit_name as to_unit_name', 'ug.qty as conversion_qty')
      .join('mm_generics as mg', 'mg.generic_id', 'pd.generic_id')
      // .join('l_bid_type as bt', 'bt.bid_id', 'pd.bid_type_id')
      .join('mm_unit_generics as ug', 'ug.unit_generic_id', 'pd.unit_generic_id')
      .join('mm_units as uf', 'uf.unit_id', 'ug.from_unit_id')
      .join('mm_units as ut', 'ut.unit_id', 'ug.to_unit_id')
      .whereIn('planning_hdr_id', headerIds)
      .groupBy('pd.generic_id');
  }

  getPlanningReport(knex: Knex, headerId: any) {
    let sql = `SELECT
            bph.planning_year,
            mg.generic_id,
            mg.generic_name,
            mga.account_id,
            mga.account_name,
            mug.qty as qty_unit,
            fct.invqty as inventory,
	          mug.qty as converse_qty,
            bpd.rate_3_year,
            bpd.rate_2_year,
            bpd.rate_1_year,
            bpd.estimate_qty,
            bpd.unit_cost,
            bpd.q1,
            bpd.q2,
            bpd.q3,
            bpd.q4,
            bpd.qty,
            bpd.amount
        FROM
            bm_planning_header bph
        JOIN bm_planning_detail bpd ON bph.planning_hdr_id = bpd.planning_hdr_id
        JOIN bm_planning_forcast as fct on fct.forcast_year = bph.planning_year and fct.generic_id = bpd.generic_id
        JOIN mm_generics mg ON bpd.generic_id = mg.generic_id
        JOIN mm_unit_generics mug ON mug.unit_generic_id = bpd.unit_generic_id
        LEFT JOIN mm_generic_accounts mga ON mga.account_id = mg.account_id
        WHERE 
            bph.planning_hdr_id = ?
        ORDER BY mg.generic_name`;
    return knex.raw(sql, headerId);
  }

}