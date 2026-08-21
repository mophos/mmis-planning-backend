import * as express from 'express';
import * as moment from 'moment';
import { SerialModel } from './../models/serial';
import AccountPayableModel from '../models/accountPayable';
const router = express.Router();

const accountPayableModel = new AccountPayableModel();
const serialModel = new SerialModel;
router.get('/', async (req, res, next) => {
  const db = req.db;
  const query = req.query.query;
  const warehouseId = req.decoded.warehouseId;
  try {
    const rs: any = await accountPayableModel.getList(db, warehouseId, query);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/info/:payableId', async (req, res, next) => {
  const db = req.db;
  const payableId = req.params.payableId;
  try {
    const rs: any = await accountPayableModel.getInfo(db, payableId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/head/:payableId', async (req, res, next) => {
  const db = req.db;
  const payableId = req.params.payableId;
  try {
    const rs: any = await accountPayableModel.getHead(db, payableId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.post('/', async (req, res, next) => {
  const db = req.db;
  const warehouseId = req.decoded.warehouseId;
  const date = req.body.date;
  const detail = req.body.detail;
  try {

    let year = moment(date, 'YYYY-MM-DD').get('year');
    let month = moment(date, 'YYYY-MM-DD').get('month') + 1;
    if (month >= 10) {
      year += 1;
    }
    const sr = await serialModel.getSerial(db, 'AR', year, warehouseId);
    const head = {
      payable_code: sr,
      payable_date: date,
      warehouse_id: warehouseId
    }
    const rs = await accountPayableModel.saveHead(db, head);
    const _detail = [];
    for (const d of detail) {
      const obj = {
        payable_id: rs[0],
        receive_id: d.receive_id
      }
      _detail.push(obj);
    }
    await accountPayableModel.saveDetail(db, _detail);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.put('/', async (req, res, next) => {
  const db = req.db;
  const warehouseId = req.decoded.warehouseId;
  const payableId = req.body.payableId;
  const detail = req.body.detail;
  try {

    const _detail = [];
    for (const d of detail) {
      const obj = {
        payable_id: payableId,
        receive_id: d.receive_id
      }
      _detail.push(obj);
    }
    await accountPayableModel.deleteDetail(db, payableId);
    await accountPayableModel.saveDetail(db, _detail);
    res.send({ ok: true });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/detail', async (req, res, next) => {
  const db = req.db;
  const payableId = req.query.payableId;
  try {
    const rs: any = await accountPayableModel.getDetail(db, payableId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/receive', async (req, res, next) => {
  const db = req.db;
  const query = req.query.query;
  const warehouseId = req.decoded.warehouseId;
  try {
    const rs: any = await accountPayableModel.getReceive(db, query, warehouseId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});


router.get('/report', async (req, res, next) => {
  try {
    const db = req.db;
    const sys_hospital = req.decoded.SYS_HOSPITAL;
    let payableId = req.query.payableId;
    let head: any = {};
    head.hospname = JSON.parse(sys_hospital).hospname;
    moment.locale('th');
    const rs: any = await accountPayableModel.accountPayableByPayableId(db, payableId);
    if (rs.length > 0) {
      let sum: any = 0;
      head.payable_code = rs[0].payable_code;
      head.payable_date = moment(rs[0].payable_date).format('DD MMMM ') + (moment(rs[0].payable_date).get('year') + 543);
      for (const i of rs) {
        i.delivery_date = moment(i.receive_date).locale('th').format('DD MMM') + (moment(i.receive_date).get('year') + 543);
        sum += i.cost;
        i.cost = accountPayableModel.comma(i.cost);
      }
      head.sum = accountPayableModel.comma(sum);
      res.render('account_payableId', {
        head: head,
        details: rs,
        printDate: 'วันที่พิมพ์ ' + moment().format('D MMMM ') + (moment().get('year') + 543) + moment().format(', HH:mm:ss น.')
      });
    } else {
      res.render('error404')
    }

  } catch (error) {
    res.render('error404', {
      title: error
    })
  } finally {
    // เดิม route นี้ไม่ปิด connection ทำให้ pool รั่วทุกครั้งที่เปิดรายงาน
    req.db.destroy();
  }
});

export default router;