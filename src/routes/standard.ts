import * as express from 'express';
import StandardModel from '../models/standard';
const router = express.Router();

const stdModel = new StandardModel();

router.get('/types', async (req, res, next) => {
  let db = req.db;
  try {
    let rs: any = await stdModel.getTypes(db);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/status', async (req, res, next) => {
  let db = req.db;
  try {
    let rs: any = await stdModel.getStatus(db);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/units/:genericId', async (req, res, next) => {
  let db = req.db;
  let genericId = req.params.genericId;

  try {
    let rs: any = await stdModel.getConversionList(db, genericId);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/bgtypes', async (req, res, next) => {
  let db = req.db;

  try {
    let rs: any = await stdModel.getBgTypes(db);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/bidtypes', async (req, res, next) => {
  let db = req.db;

  try {
    let rs: any = await stdModel.getBidTypes(db);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/copurchase', async (req, res, next) => {
  let db = req.db;

  try {
    let rs: any = await stdModel.getCoPurchase(db);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/search/labelers', async (req, res, next) => {
  let db = req.db;
  let type = req.query.type;
  let query = req.query.q;

  try {
    let rs: any = await stdModel.searchLabeler(db, query, type);
    res.send(rs);
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/search/products/autocomplete', async (req, res, next) => {
  let db = req.db;
  let query = req.query.q;
  let vendorId = req.query.vendorId === 'undefined' || req.query.vendorId === null ? null : req.query.vendorId;

  try {
    let rs: any = await stdModel.searchProductAutoComplete(db, query, vendorId);
    res.send(rs);
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/search/generic/autocomplete', async (req, res, next) => {
  let db = req.db;
  let query = req.query.q;

  try {
    let rs: any = await stdModel.searchGenericAutoComplete(db, query);
    res.send(rs);
  } catch (error) {
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

router.get('/generic-types', async (req, res, next) => {
  let db = req.db;
  let genericGroups = req.decoded.generic_type_id;

  try {
    let _ggs = [];
    if (genericGroups) {
      let pgs = genericGroups.split(',');
      pgs.forEach(v => {
        _ggs.push(v);
      });
    }

    let rs = await stdModel.getGenericTypes(db, _ggs);
    res.send({ ok: true, rows: rs });
  } catch (error) {
    console.log(error);
    res.send({ ok: false, error: error.message });
  } finally {
    db.destroy();
  }
});

export default router;