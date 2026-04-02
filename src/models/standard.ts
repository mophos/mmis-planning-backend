import * as Knex from 'knex';

export default class StandardModel {

  searchProductAutoComplete(db: Knex, query: any, vendorId: any): any {
    let _query = `${query}%`;
    let sql = db('mm_products as mp')
      .select(db.raw('concat(mp.product_name, " (", l.labeler_name, ")") as product_name'), 'mp.product_id',
        'mp.primary_unit_id', 'mp.working_code', 'mg.working_code as generic_workign_code', 'mp.is_lot_control',
        'mu.unit_name as primary_unit_name', 'mg.generic_name', 'mp.generic_id', 'vcmp.contract_id', 'vcmp.contract_no', 'vcmp.prepare_no')
      .leftJoin('mm_generics as mg', 'mg.generic_id', 'mp.generic_id')
      .leftJoin('mm_units as mu', 'mu.unit_id', 'mp.primary_unit_id')
      .leftJoin('mm_labelers as l', 'l.labeler_id', 'mp.v_labeler_id')
      .leftJoin('view_cm_products_active as vcmp', 'vcmp.product_id', 'mp.product_id')
      .where(w => {
        w.where('mp.product_name', 'like', _query)
          .orWhere('mg.generic_name', 'like', _query)
          .orWhere('mg.working_code', query)
          .orWhere('mp.working_code', query)
          .orWhere('mp.keywords', 'like', _query)
      })
      .where('mp.is_active', 'Y')
      .where('mp.mark_deleted', 'N');

    if (vendorId) sql.where('mp.v_labeler_id', vendorId);

    sql.orderBy('mp.product_name');
    sql.limit(10);

    return sql;

  }

  searchGenericAutoComplete(db: Knex, query: any): any {
    let _query = `${query}%`;
    let sql = db('mm_generics as mg')
      .select('mg.generic_id', 'mg.generic_name', 'mg.purchasing_method', 'mg.planning_freeze', 'mg.generic_type_id'
    , 'planning_unit_generic_id')
      // .where('mg.is_planning', 'Y')
      .where('mg.is_active', 'Y')
      .where('mg.mark_deleted', 'N')
      .where(w => {
        w.where('mg.generic_name', 'like', _query)
          .orWhere('mg.working_code', query)
          .orWhere('mg.keywords', 'like', _query)
      });
    sql.orderBy('mg.generic_name');
    sql.limit(10);
    return sql;
  }

  getTypes(db: Knex) {
    return db('cm_types')
      .orderBy('type_name');
  }

  getBgTypes(db: Knex) {
    return db('bm_bgtype')
      .orderBy('bgtype_name');
  }

  getBidTypes(db: Knex) {
    return db('l_bid_type')
      .orderBy('bid_name');
  }

  getCoPurchase(db: Knex) {
    return db('bi_co_purchase')
      .orderBy('co_purchase_id');
  }

  getStatus(db: Knex) {
    return db('cm_status')
      .orderBy('status_name');
  }

  searchLabeler(db: any, query: any, type: any = 'V') {
    let _query = `${query}%`;
    let sql = db('mm_labelers as l')
      .where(w => {
        w.where('l.labeler_name', 'like', _query)
          .orWhere('l.short_code', query)
          .orWhere('l.nin', query)

      });

    type === 'M' ? sql.where('l.is_manufacturer', 'Y') : sql.where('l.is_vendor', 'Y');

    return sql.limit(10);
  }

  getConversionList(db: Knex, genericId: any) {
    return db('mm_unit_generics as ug')
      .select('ug.*', 'uf.unit_name as from_unit_name', 'ut.unit_name as to_unit_name')
      .innerJoin('mm_units as uf', 'uf.unit_id', 'ug.from_unit_id')
      .innerJoin('mm_units as ut', 'ut.unit_id', 'ug.to_unit_id')
      .where('ug.generic_id', genericId)
      .where('ug.is_deleted', 'N')
      .where('ug.is_active', 'Y')
      .groupByRaw('ug.generic_id, unit_generic_id');
  }

  getGenericTypes(knex: Knex, _genericGroups: any[]) {
    return knex('mm_generic_types')
      .whereIn('generic_type_id', _genericGroups)
      .andWhere('is_actived', 1);
  }

}