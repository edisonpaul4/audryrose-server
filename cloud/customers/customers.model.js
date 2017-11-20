var { BaseModel } = require('../database/base.model');
var moment = require('moment');

exports.CustomersModel = new class CustomersModel extends BaseModel {
  constructor() {
    super();
    this.Customer = new Parse.Object.extend('Customer');
  }

  /**
   * @returns {Promise} - Array of objects
   * @param {Object} params - base query params
   */
  getCustomersByFilters(params) {
    var customersQuery = new Parse.Query(this.Customer);
    return this.searchDatabase(params, customersQuery);
  } // END getCustomersByFilters

}