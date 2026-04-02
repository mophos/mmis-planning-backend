import * as Knex from 'knex';

export default class BidTypeModel {

  getBidType(knex: Knex) {
    return knex('l_bid_type as bt')
      .select('bt.*', 'cp.co_purchase_name')
      .leftJoin('bi_co_purchase as cp', 'cp.co_purchase_id', 'bt.co_purchase_id')
      .orderBy('bt.bid_name');
  }

  insertBidType(knex: Knex, data: any) {
    return knex('l_bid_type')
      .insert(data);
  }

  updateBidType(knex: Knex, bidId, data) {
    return knex('l_bid_type')
      .where('bid_id', bidId)
      .update(data);
  }

  deleteBidType(knex: Knex, bidId) {
    return knex('l_bid_type')
      .where('bid_id', bidId)
      .del();
  }

  updateNonDefault(knex: Knex) {
    return knex('l_bid_type')
      .update('isdefault', 'N');
  }

}